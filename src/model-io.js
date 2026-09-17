import * as THREE from 'three';
import { GLTFLoader } from '../vendor/addons/loaders/GLTFLoader.js';
import { OBJLoader } from '../vendor/addons/loaders/OBJLoader.js';
import { GLTFExporter } from '../vendor/addons/exporters/GLTFExporter.js';

function materialsOf(object) {
  return object.material ? (Array.isArray(object.material) ? object.material : [object.material]) : [];
}

/** A separate material per preview keeps display toggles away from the approved assembly. */
export function clonePart(source) {
  const copy = source.clone(true);
  copy.traverse((object) => {
    if (object.material) {
      object.material = Array.isArray(object.material)
        ? object.material.map((material) => material.clone())
        : object.material.clone();
    }
  });
  return copy;
}

export function disposeObjects(objects) {
  const geometries = new Set();
  const materials = new Set();
  const textures = new Set();
  for (const root of objects) {
    root?.traverse((object) => {
      if (object.geometry) geometries.add(object.geometry);
      for (const material of materialsOf(object)) {
        materials.add(material);
        for (const value of Object.values(material)) if (value?.isTexture) textures.add(value);
      }
    });
  }
  for (const resource of [...textures, ...materials, ...geometries]) resource.dispose();
}

export function describeObject(root) {
  let meshes = 0;
  let vertices = 0;
  let triangles = 0;
  root.traverse((object) => {
    if (!object.isMesh) return;
    meshes += 1;
    const positions = object.geometry?.attributes.position;
    vertices += positions?.count ?? 0;
    triangles += (object.geometry?.index?.count ?? positions?.count ?? 0) / 3;
  });
  root.updateWorldMatrix(true, true);
  const box = new THREE.Box3().setFromObject(root);
  return { meshes, vertices, triangles, bounds: { min: box.min.toArray(), max: box.max.toArray() } };
}

function validateStaticMesh(root, limits) {
  let totalVertices = 0;
  let meshCount = 0;
  root.traverse((object) => {
    if (object.isSkinnedMesh || object.isBone) throw new Error('当前部件入口接受未绑定骨骼的静态模型，请先导出静态副本。');
    if (object.isLight || object.isCamera || object.isLine || object.isPoints) throw new Error('部件文件只能包含三角网格，不能包含灯光、相机、线段或点云。');
    if (![...object.position, ...object.quaternion, ...object.scale, ...object.matrix.elements].every(Number.isFinite)) {
      throw new Error('模型变换包含无效数值。');
    }
    if (!object.isMesh) return;
    meshCount += 1;
    const position = object.geometry?.getAttribute('position');
    if (!position || position.count < 3) throw new Error('模型中存在没有有效顶点的网格。');
    totalVertices += position.count;
    if (totalVertices > limits.maxVertices || meshCount > limits.maxMeshes) throw new Error('模型复杂度超过当前部件导入上限。');
    for (let index = 0; index < position.count; index += 1) {
      if (![position.getX(index), position.getY(index), position.getZ(index)].every(Number.isFinite)) {
        throw new Error('模型顶点包含无效数值。');
      }
    }
    const indices = object.geometry.index;
    const indexCount = indices?.count ?? position.count;
    if (indexCount % 3 !== 0) throw new Error('模型中存在不完整的三角形。');
    if (indices) {
      for (let index = 0; index < indices.count; index += 1) {
        const value = indices.getX(index);
        if (!Number.isInteger(value) || value < 0 || value >= position.count) throw new Error('模型中存在越界的三角形索引。');
      }
    }
    if (!object.geometry.attributes.normal) object.geometry.computeVertexNormals();
  });
  if (!meshCount) throw new Error('文件中没有可显示的三角网格。');
  const info = describeObject(root);
  if (![...info.bounds.min, ...info.bounds.max].every(Number.isFinite)) throw new Error('模型包围盒无效。');
  const size = new THREE.Vector3().subVectors(new THREE.Vector3(...info.bounds.max), new THREE.Vector3(...info.bounds.min));
  if (size.length() === 0) throw new Error('模型尺寸为零。');
  if (size.length() > limits.maxExtent) throw new Error('模型尺寸超出小白工作空间，请先统一模型单位。');
  return info;
}

function validateGLBEnvelope(buffer, limits) {
  if (buffer.byteLength < 20) throw new Error('GLB 文件过短或已损坏。');
  const view = new DataView(buffer);
  if (view.getUint32(0, true) !== 0x46546c67 || view.getUint32(4, true) !== 2) throw new Error('请选择有效的 glTF 2.0 二进制 GLB 文件。');
  if (view.getUint32(8, true) !== buffer.byteLength) throw new Error('GLB 文件长度校验失败。');
  let json;
  for (let offset = 12; offset < buffer.byteLength;) {
    if (offset + 8 > buffer.byteLength) throw new Error('GLB 数据块不完整。');
    const length = view.getUint32(offset, true);
    const type = view.getUint32(offset + 4, true);
    if (offset + 8 + length > buffer.byteLength) throw new Error('GLB 数据块越界。');
    if (type === 0x4e4f534a) json = JSON.parse(new TextDecoder().decode(new Uint8Array(buffer, offset + 8, length)));
    offset += 8 + length;
  }
  if (!json || json.asset?.version !== '2.0') throw new Error('GLB 缺少有效的 glTF 2.0 描述。');
  for (const entry of [...(json.buffers ?? []), ...(json.images ?? [])]) {
    if (entry.uri && !entry.uri.startsWith('data:')) throw new Error('GLB 包含外部文件引用，请将纹理和缓冲区嵌入单个 GLB 后再导入。');
  }
  if (json.skins?.length || json.animations?.length) throw new Error('当前部件入口接受静态模型，请移除原骨骼和动画后再导入。');
  // Check declared allocation sizes before the loader creates typed arrays (including sparse accessors).
  if ((json.meshes?.length ?? 0) > limits.maxMeshes) throw new Error('模型网格数量超过当前部件导入上限。');
  for (const accessor of json.accessors ?? []) {
    if (!Number.isSafeInteger(accessor.count) || accessor.count < 0 || accessor.count > limits.maxVertices * 3) {
      throw new Error('GLB 顶点或索引声明超过当前部件导入上限。');
    }
  }
  let declaredVertices = 0;
  let declaredPrimitives = 0;
  for (const mesh of json.meshes ?? []) {
    for (const primitive of mesh.primitives ?? []) {
      declaredPrimitives += 1;
      const position = json.accessors?.[primitive.attributes?.POSITION];
      declaredVertices += position?.count ?? 0;
      if (declaredVertices > limits.maxVertices || declaredPrimitives > limits.maxMeshes) throw new Error('模型复杂度超过当前部件导入上限。');
    }
  }
  return json;
}

export async function loadApproved(url) {
  return (await new GLTFLoader().loadAsync(url)).scene;
}

/** Parses and validates in isolation; callers commit the result only after this resolves. */
export async function importCandidate(file, limits) {
  if (!file || typeof file.arrayBuffer !== 'function') throw new Error('请选择一个模型文件。');
  if (file.size > limits.maxBytes) throw new Error(`模型文件超过 ${Math.round(limits.maxBytes / 1024 / 1024)} MB 上限。`);
  const extension = file.name.split('.').pop().toLowerCase();
  let root;
  const warnings = [];
  try {
    if (extension === 'glb') {
      const buffer = await file.arrayBuffer();
      validateGLBEnvelope(buffer, limits);
      const manager = new THREE.LoadingManager();
      manager.setURLModifier((url) => {
        if (!url.startsWith('blob:') && !url.startsWith('data:')) throw new Error('已拒绝模型的外部资源请求。');
        return url;
      });
      root = (await new GLTFLoader(manager).parseAsync(buffer, '')).scene;
    } else if (extension === 'obj') {
      const source = await file.text();
      root = new OBJLoader().parse(source);
      if (/^\s*mtllib\s+/m.test(source)) warnings.push('已导入 OBJ 几何；外部 MTL / 纹理未加载。');
    } else {
      throw new Error('目前支持单文件 GLB 或 OBJ。');
    }
    const stats = validateStaticMesh(root, limits);
    root.name = file.name;
    root.userData = { ...root.userData, sourceFile: file.name, approval: 'pending', sourceType: 'user-import' };
    return { root, ...stats, name: file.name, format: extension, warnings };
  } catch (error) {
    if (root) disposeObjects([root]);
    throw error;
  }
}

export async function exportModel(root) {
  const snapshot = clonePart(root);
  const geometryCopies = new Map();
  const materialCopies = new Set();
  snapshot.traverse((object) => {
    if (object.geometry) {
      if (!geometryCopies.has(object.geometry)) geometryCopies.set(object.geometry, object.geometry.clone());
      object.geometry = geometryCopies.get(object.geometry);
    }
    for (const material of materialsOf(object)) {
      // GLTFExporter maps wireframe Mesh materials to LINES. It is a display option here;
      // exports must retain triangle meshes, without changing the current preview.
      material.wireframe = false;
      materialCopies.add(material);
    }
  });
  snapshot.updateMatrixWorld(true);
  try {
    return await new GLTFExporter().parseAsync(snapshot, { binary: true, onlyVisible: true, trs: true });
  } finally {
    // Textures are shared and remain owned by the source; dispose only the snapshot copies.
    for (const geometry of geometryCopies.values()) geometry.dispose();
    for (const material of materialCopies) material.dispose();
  }
}
