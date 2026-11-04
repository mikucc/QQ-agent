// 每日日程 · 类型与兜底模板
export const TYPES = {
  workday: { name: '赶稿日', icon: 'writing' },
  rest: { name: '休息日', icon: 'rest' },
  out: { name: '外出日', icon: 'out' },
  home: { name: '宅家日', icon: 'home' },
  overtime: { name: '赶稿到深夜', icon: 'overtime' },
  slack: { name: '摸鱼日', icon: 'slack' }
};

const DEFAULT_WEIGHTS = {
  workday: 3,
  rest: 2,
  out: 2,
  home: 3,
  overtime: 1,
  slack: 2
};

function seg(start, end, activity, location = '家', extra = {}) {
  return { start, end, activity, location, with: '', note: '', ...extra };
}

export function parseWeights(text) {
  const out = {};
  for (const part of String(text || '').split(/[,，\n]+/)) {
    const m = part.match(/^\s*([a-z_-]+)\s*[:：]\s*(\d+(?:\.\d+)?)\s*$/i);
    if (!m) continue;
    if (!TYPES[m[1]]) continue;
    const weight = Math.max(0, Number(m[2]) || 0);
    if (weight > 0) out[m[1]] = weight;
  }
  return Object.keys(out).length ? out : { ...DEFAULT_WEIGHTS };
}

export function pickDayType({ weekend = false, weightsText = '', random = Math.random } = {}) {
  const weights = parseWeights(weightsText);
  // 周末把工作类压低，休息/外出/宅家抬高；工作日反过来。
  const adjusted = { ...weights };
  if (weekend) {
    adjusted.workday = (adjusted.workday || 0) * 0.3;
    adjusted.overtime = (adjusted.overtime || 0) * 0.3;
    adjusted.rest = (adjusted.rest || 0) * 1.4;
    adjusted.out = (adjusted.out || 0) * 1.4;
    adjusted.home = (adjusted.home || 0) * 1.2;
  } else {
    adjusted.rest = (adjusted.rest || 0) * 0.7;
    adjusted.out = (adjusted.out || 0) * 0.8;
  }
  const list = Object.entries(adjusted).filter(([, w]) => w > 0);
  const total = list.reduce((n, [, w]) => n + w, 0);
  if (!list.length || total <= 0) return 'home';
  let roll = random() * total;
  for (const [name, w] of list) {
    roll -= w;
    if (roll <= 0) return name;
  }
  return list[list.length - 1][0];
}

export function templateFor(dayType = 'home') {
  const type = TYPES[dayType] ? dayType : 'home';
  if (type === 'workday') {
    return [
      seg('00:00', '07:30', '睡觉'),
      seg('07:30', '08:30', '起床，煮点热的当早餐'),
      seg('09:00', '12:00', '写稿', '家', { note: '上午精神最好，先写难的部分' }),
      seg('12:00', '13:30', '午饭，顺便下楼走走', '楼下'),
      seg('14:00', '18:00', '继续写稿', '家'),
      seg('18:00', '19:00', '去河边步道走一圈', '河边'),
      seg('19:00', '20:00', '晚饭', '家', { note: '饭后想吃点甜的' }),
      seg('20:00', '23:30', '看剧、刷手机、收尾', '家'),
      seg('23:30', '24:00', '洗漱，准备睡')
    ];
  }
  if (type === 'overtime') {
    return [
      seg('00:00', '07:00', '睡觉'),
      seg('07:00', '08:00', '起床，随便吃点'),
      seg('08:00', '12:00', '赶稿', '家'),
      seg('12:00', '13:00', '午饭', '楼下'),
      seg('13:00', '18:00', '继续赶稿', '家'),
      seg('18:00', '19:00', '晚饭，缓一口气'),
      seg('19:00', '23:30', '继续赶稿', '家', { note: '今天必须交' }),
      seg('23:30', '24:00', '洗漱，倒头就睡')
    ];
  }
  if (type === 'out') {
    return [
      seg('00:00', '08:00', '睡觉'),
      seg('08:00', '09:00', '起床，吃早餐'),
      seg('09:00', '12:00', '出门办事、顺便逛逛', '外面'),
      seg('12:00', '13:00', '在外面吃午饭', '外面'),
      seg('13:00', '17:00', '找家咖啡店坐一会儿', '外面'),
      seg('17:00', '18:00', '慢慢走回家', '路上'),
      seg('18:00', '19:00', '晚饭', '家'),
      seg('19:00', '23:00', '在家放松', '家'),
      seg('23:00', '24:00', '洗漱睡觉')
    ];
  }
  if (type === 'rest') {
    return [
      seg('00:00', '09:00', '睡到自然醒'),
      seg('09:00', '10:00', '早午饭一起吃了'),
      seg('10:00', '12:00', '收拾屋子、洗衣服'),
      seg('12:00', '13:00', '午饭', '楼下'),
      seg('13:00', '17:00', '看剧、看书、躺着', '家'),
      seg('17:00', '18:00', '去楼下便利店买点东西', '楼下'),
      seg('18:00', '19:00', '晚饭', '家'),
      seg('19:00', '22:30', '继续放松', '家'),
      seg('22:30', '24:00', '洗漱睡觉')
    ];
  }
  if (type === 'slack') {
    return [
      seg('00:00', '09:00', '睡觉'),
      seg('09:00', '10:00', '起床，吃早餐'),
      seg('10:00', '12:00', '打开文档，摸鱼', '家'),
      seg('12:00', '13:00', '午饭', '楼下'),
      seg('13:00', '17:00', '打游戏、看视频', '家'),
      seg('17:00', '18:00', '去河边走一圈', '河边'),
      seg('18:00', '19:00', '晚饭', '家'),
      seg('19:00', '23:00', '继续摸鱼', '家'),
      seg('23:00', '24:00', '洗漱睡觉')
    ];
  }
  return [
    seg('00:00', '09:00', '睡觉'),
    seg('09:00', '10:00', '起床，吃早餐'),
    seg('10:00', '12:00', '写点东西', '家'),
    seg('12:00', '13:00', '午饭', '楼下'),
    seg('13:00', '17:00', '看书、看剧', '家'),
    seg('17:00', '18:00', '下楼走走', '楼下'),
    seg('18:00', '19:00', '晚饭', '家'),
    seg('19:00', '23:00', '放松', '家'),
    seg('23:00', '24:00', '洗漱睡觉')
  ];
}

export function dayTypeName(type) {
  return TYPES[type]?.name || TYPES.home.name;
}
