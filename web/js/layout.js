export const COLORS = { object: '#a78bfa', character: '#3ddc97', text: '#68a8ff' };
export const LABELS = { object: '物体', character: '人物', text: '文字' };

export const RATIOS = {
  '1:1': [1, 1], '4:3': [4, 3], '3:4': [3, 4], '3:2': [3, 2], '2:3': [2, 3],
  '16:9': [16, 9], '9:16': [9, 16], '21:9': [21, 9], '9:21': [9, 21],
  '2:1': [2, 1], '1:2': [1, 2], '1:8': [1, 8],
};

export function sizeFor(ratioKey, megapixels) {
  const ratio = RATIOS[ratioKey];
  if (!ratio) return null;
  const px = Math.max(0.05, Number(megapixels) || 1.5) * 1e6;
  let height = Math.sqrt((px * ratio[1]) / ratio[0]);
  let width = px / height;
  width = Math.max(16, Math.round(width / 16) * 16);
  height = Math.max(16, Math.round(height / 16) * 16);
  return [width, height];
}

const toInt = (value, fallback = 0) => {
  const number = Number(value);
  return Number.isFinite(number) ? Math.round(number) : fallback;
};

const list = (value) => {
  if (Array.isArray(value)) return value.map((v) => String(v).trim()).filter(Boolean);
  return String(value || '').split(/[,，]/).map((s) => s.trim()).filter(Boolean);
};

/** 服务端已归一化，这里再兜一层，避免历史数据把 UI 弄崩。 */
export function normDoc(raw) {
  const doc = raw && typeof raw === 'object' ? raw : {};
  const width = Math.max(16, toInt(doc.width, 1152));
  const height = Math.max(16, toInt(doc.height, 1536));
  const summary = doc.summary && typeof doc.summary === 'object' ? doc.summary : {};
  const items = Array.isArray(doc.items) ? doc.items : [];
  return {
    width,
    height,
    summary: {
      caption: String(summary.caption || summary.caption_zh || ''),
      meta: list(summary.meta),
      canvas: ['single', 'multi_panel', 'collage'].includes(summary.canvas) ? summary.canvas : 'single',
      palette: list(summary.palette),
    },
    items: items.map((item) => {
      const box = Array.isArray(item?.bbox) ? item.bbox.map((v) => toInt(v, 0)) : [0, 0, 0, 0];
      const x1 = Math.max(0, Math.min(width - 8, box[0] ?? 0));
      const y1 = Math.max(0, Math.min(height - 8, box[1] ?? 0));
      const x2 = Math.max(x1 + 8, Math.min(width, box[2] ?? 0));
      const y2 = Math.max(y1 + 8, Math.min(height, box[3] ?? 0));
      return {
        label: LABELS[item?.label] ? item.label : 'object',
        caption: String(item?.caption || item?.caption_zh || ''),
        text: String(item?.text || ''),
        tags: list(item?.tags),
        palette: list(item?.palette),
        bbox: [x1, y1, x2, y2],
      };
    }),
  };
}

export const isGround = (box, width, height) =>
  box[2] - box[0] >= width * 0.9 && box[3] - box[1] >= height * 0.9;

export const contains = (a, b) => a[0] <= b[0] && a[1] <= b[1] && a[2] >= b[2] && a[3] >= b[3];

export function pairsOverlap(doc) {
  const { width, height, items } = doc;
  const pairs = [];
  for (let i = 0; i < items.length; i += 1) {
    for (let j = i + 1; j < items.length; j += 1) {
      const a = items[i].bbox;
      const b = items[j].bbox;
      if (isGround(a, width, height) || isGround(b, width, height)) continue;
      if (contains(a, b) || contains(b, a)) continue;
      const x1 = Math.max(a[0], b[0]);
      const y1 = Math.max(a[1], b[1]);
      const x2 = Math.min(a[2], b[2]);
      const y2 = Math.min(a[3], b[3]);
      if (x2 - x1 > 0 && y2 - y1 > 0) {
        pairs.push({ i, j, rect: [x1, y1, x2, y2], area: (x2 - x1) * (y2 - y1) });
      }
    }
  }
  return pairs.sort((p, q) => q.area - p.area);
}

export const hasOcclusion = (item) => /in front of|behind|occlud|hidden/i.test(item?.caption || '');
