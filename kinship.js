// kinship.js — 조류 계통수 기반 촌수(친족도) 라벨링
//
// 사용자의 `Unified_Fractal_Metadata.json` 로드 결과(treeMap)와 직접 연동.
// 추가로 필요한 데이터는 `inter_order_ages.json` 하나뿐.
//
// === 사용 예 ===
//   import { buildKinshipContext, kinshipLabel, groupByKinship } from './kinship.js';
//   const ctx = buildKinshipContext(treeMap, interOrderAges);
//   const label = kinshipLabel('Corvus_corone', 'Pica_pica', ctx);
//   // → '4촌'
//
//   // 기준 종 중심으로 다른 종들을 촌수 그룹으로 정렬
//   const groups = groupByKinship('Corvus_corone', others, ctx);
//   // → [{label:'형제', rank:1, members:[...]}, {label:'4촌', rank:2, ...}, ...]
//
// === 라벨 체계 ===
//   같은 종                     → 나
//   같은 속                     → 형제
//   같은 과                     → 4촌
//   같은 목, ≤40 MYA             → 6촌
//   같은 목, >40 MYA             → 8촌
//   다른 목 (앵커 기준 tertile)  → 먼 친척 / 아주 먼 친척 / 거의 남
//
// 다른 목의 3분류는 **앵커 종의 목** 기준 상대 거리에 따라 결정.
// 예: 닭목을 클릭하면 기러기목이 "먼 친척"(가장 가까운 tier),
//     타조목을 클릭하면 다른 고악류들이 "먼 친척", 신악류는 "거의 남".

// ============================================================
// 상수
// ============================================================

export const LABELS = {
  SELF:     '나',
  SIBLING:  '형제',         // 같은 속
  FOUR:     '4촌',          // 같은 과
  SIX:      '6촌',          // 같은 목, 가까움
  EIGHT:    '8촌',          // 같은 목, 멀다
  FAR:      '먼 친척',      // 다른 목, 가까운 tier
  FARTHER:  '아주 먼 친척', // 다른 목, 중간 tier
  STRANGER: '거의 남',      // 다른 목, 먼 tier
  UNKNOWN:  '분류 미상',
};

export const RANK = {
  [LABELS.SELF]:     0,
  [LABELS.SIBLING]:  1,
  [LABELS.FOUR]:     2,
  [LABELS.SIX]:      3,
  [LABELS.EIGHT]:    4,
  [LABELS.FAR]:      5,
  [LABELS.FARTHER]:  6,
  [LABELS.STRANGER]: 7,
  [LABELS.UNKNOWN]:  99,
};

// 같은 목 안에서 6촌/8촌 경계 (MYA)
export const WITHIN_ORDER_NEAR = 40;

// ============================================================
// 헬퍼
// ============================================================

/** 'Struthionidae (Ostriches)' → 'Struthionidae' */
function cleanFamily(f) {
  if (!f) return '';
  const i = f.indexOf('(');
  return (i >= 0 ? f.slice(0, i) : f).trim();
}

/** 'Corvus_corone' → 'Corvus' */
function genusOf(name) {
  if (!name) return '';
  const i = name.indexOf('_');
  return i >= 0 ? name.slice(0, i) : name;
}

/** tip 노드인지 판정 (name에 'Node_'가 없고 order 정보 있음) */
function isLeaf(node) {
  if (!node) return false;
  if (node._isLeaf !== undefined) return node._isLeaf;
  return !!(node.o && !String(node.n || '').includes('Node_'));
}

// ============================================================
// 다른 목 tertile 분류표 생성
// ============================================================

/**
 * 각 앵커 목(O_A) 기준으로 다른 목들을 3분위(먼 친척 / 아주 먼 친척 / 거의 남)로 분류.
 * interOrderAges[O_A][O_B] = MYA 를 소비해서
 *   tertileBins[O_A][O_B] = label 테이블을 만들어 반환.
 */
export function buildTertileBins(interOrderAges) {
  const out = {};
  for (const anchor of Object.keys(interOrderAges)) {
    const others = interOrderAges[anchor];
    const values = Object.values(others);
    if (values.length === 0) { out[anchor] = {}; continue; }
    let vmin = Infinity, vmax = -Infinity;
    for (const v of values) { if (v < vmin) vmin = v; if (v > vmax) vmax = v; }
    const range = vmax - vmin;
    const b1 = vmin + range / 3;
    const b2 = vmin + 2 * range / 3;
    const bin = {};
    for (const [ob, t] of Object.entries(others)) {
      if (t <= b1)      bin[ob] = LABELS.FAR;
      else if (t <= b2) bin[ob] = LABELS.FARTHER;
      else              bin[ob] = LABELS.STRANGER;
    }
    out[anchor] = bin;
  }
  return out;
}

// ============================================================
// 이름 → UID 인덱스
// ============================================================

/**
 * treeMap (id→노드) 로부터 'Corvus_corone' 같은 학명으로 UID를 찾을 수 있는 인덱스 생성.
 * leaf 노드의 `n` 필드(학명)를 키로 사용.
 */
export function buildNameIndex(treeMap) {
  const idx = Object.create(null);
  for (const id in treeMap) {
    const d = treeMap[id];
    if (isLeaf(d) && d.n) idx[d.n] = id;
  }
  return idx;
}

// ============================================================
// MRCA (부모 포인터 기반)
// ============================================================

/** 두 UID의 공통조상 노드를 찾고 그 age(MYA)를 반환. */
export function mrcaAge(idA, idB, treeMap) {
  if (!idA || !idB || !treeMap[idA] || !treeMap[idB]) return null;
  if (idA === idB) return 0;

  // A의 조상 체인 집합 (자기 자신 포함)
  const chainA = new Set();
  let cur = treeMap[idA];
  while (cur) {
    chainA.add(cur.id);
    cur = cur.p ? treeMap[cur.p] : null;
  }

  // B의 조상 체인을 올라가며 A 체인과 첫 교차점 찾기
  let curB = treeMap[idB];
  while (curB) {
    if (chainA.has(curB.id)) {
      return curB.absAge !== undefined ? curB.absAge : (curB.age || 0);
    }
    curB = curB.p ? treeMap[curB.p] : null;
  }
  return null;
}

// ============================================================
// 컨텍스트 빌드 (한 번만 호출)
// ============================================================

/**
 * 앱 시작 시 한 번만 호출해서 이후 kinshipLabel/groupByKinship에 넘겨줌.
 * @param {Object} treeMap - Object.keys(data).map(id=>({id, ...data[id]})) 결과의 id-indexed 맵
 * @param {Object} interOrderAges - inter_order_ages.json 로드 결과
 */
export function buildKinshipContext(treeMap, interOrderAges) {
  return {
    treeMap,
    nameIndex: buildNameIndex(treeMap),
    tertileBins: buildTertileBins(interOrderAges),
  };
}

// ============================================================
// 메인 라벨링 함수
// ============================================================

/**
 * 두 종(학명)의 친족 라벨을 계산.
 * @param {string} anchorName - 기준 종 학명 (예: 'Corvus_corone')
 * @param {string} otherName  - 비교 종 학명
 * @param {Object} ctx        - buildKinshipContext(...) 반환값
 * @returns {string} 라벨
 */
export function kinshipLabel(anchorName, otherName, ctx) {
  if (!ctx) return LABELS.UNKNOWN;
  if (anchorName === otherName) return LABELS.SELF;

  const { treeMap, nameIndex, tertileBins } = ctx;
  const idA = nameIndex[anchorName];
  const idB = nameIndex[otherName];
  if (!idA || !idB) return LABELS.UNKNOWN;

  const a = treeMap[idA], b = treeMap[idB];
  if (!a || !b) return LABELS.UNKNOWN;

  // 1. 같은 속 → 형제 (학명에서 속명 추출)
  if (genusOf(a.n) && genusOf(a.n) === genusOf(b.n)) return LABELS.SIBLING;

  // 2. 같은 과 → 4촌
  const fa = cleanFamily(a.f), fb = cleanFamily(b.f);
  if (fa && fa === fb) return LABELS.FOUR;

  // 3. 같은 목 → 분기 시점으로 6촌/8촌
  if (a.o && a.o === b.o) {
    const age = mrcaAge(idA, idB, treeMap);
    if (age === null) return LABELS.UNKNOWN;
    return age <= WITHIN_ORDER_NEAR ? LABELS.SIX : LABELS.EIGHT;
  }

  // 4. 다른 목 → 앵커 목 기준 tertile
  if (a.o && b.o && tertileBins[a.o] && tertileBins[a.o][b.o]) {
    return tertileBins[a.o][b.o];
  }
  return LABELS.UNKNOWN;
}

// ============================================================
// 그룹화/정렬
// ============================================================

/**
 * 기준 종으로부터 다른 종들을 촌수로 묶고, 각 그룹 내에서 MYA(또는 제공된 값) 오름차순 정렬.
 * @param {string} anchorName - 기준 종 학명
 * @param {Array<string|{name:string, mya?:number}>} others - 종 이름 배열 또는 {name, mya} 객체 배열
 * @param {Object} ctx
 * @returns {Array<{label:string, rank:number, members:Array}>}
 */
export function groupByKinship(anchorName, others, ctx) {
  if (!ctx) return [];
  const buckets = new Map();

  for (const o of others) {
    const name = typeof o === 'string' ? o : o.name;
    if (!name || name === anchorName) continue;
    const label = kinshipLabel(anchorName, name, ctx);
    // 같은 그룹 안에서 정렬하려면 mya가 필요 — 없으면 계산
    let mya = (typeof o === 'object' && o.mya !== undefined) ? o.mya : null;
    if (mya === null) {
      const idA = ctx.nameIndex[anchorName];
      const idB = ctx.nameIndex[name];
      if (idA && idB) mya = mrcaAge(idA, idB, ctx.treeMap);
    }
    if (!buckets.has(label)) buckets.set(label, []);
    buckets.get(label).push({
      name,
      mya: mya == null ? Infinity : mya,
      ...(typeof o === 'object' ? o : {}),
    });
  }

  const groups = [];
  for (const [label, members] of buckets) {
    members.sort((x, y) => x.mya - y.mya);
    groups.push({ label, rank: RANK[label] ?? 99, members });
  }
  groups.sort((x, y) => x.rank - y.rank);
  return groups;
}

// ============================================================
// CommonJS 대응
// ============================================================
if (typeof module !== 'undefined' && module.exports) {
  module.exports = {
    LABELS, RANK, WITHIN_ORDER_NEAR,
    buildTertileBins, buildNameIndex, buildKinshipContext,
    mrcaAge, kinshipLabel, groupByKinship,
  };
}
