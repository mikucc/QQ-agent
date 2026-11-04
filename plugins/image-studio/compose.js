// 生图工作室 · 画面组合
import { mentionedIn, resolveRef } from './library.js';

const LABEL = { characters: '人物', outfits: '服饰', scenes: '场景', props: '道具' };

function asList(v) {
  if (Array.isArray(v)) return v.map((x) => String(x).trim()).filter(Boolean);
  if (typeof v === 'string' && v.trim()) return [v.trim()];
  return [];
}

function oneLine(s, n = 300) {
  return String(s || '').replace(/\s+/g, ' ').trim().slice(0, n);
}

function pickMany(category, refs, lib, unresolved) {
  const out = [];
  for (const ref of refs) {
    const entry = resolveRef(category, ref, lib);
    if (!entry) { unresolved.push(`${LABEL[category]}「${ref}」`); continue; }
    if (!out.includes(entry)) out.push(entry);
  }
  return out;
}

/**
 * 把画面描述、关键词和库条目组合成一次生图请求。
 * 参考图只保证长相/服装/场景设计，姿势表情构图由文字决定。
 */
export function compose(args = {}, cfg = {}, lib = {}) {
  const notes = [];
  const unresolved = [];
  const prompt = String(args.prompt || '').trim();
  const autoMatch = cfg.autoMatch !== false;

  const characters = pickMany('characters', asList(args.characters), lib, unresolved);
  const outfits = pickMany('outfits', asList(args.outfits), lib, unresolved);
  const scenes = pickMany('scenes', asList(args.scene), lib, unresolved);
  const props = pickMany('props', asList(args.props), lib, unresolved);
  if (scenes.length > 1) notes.push(`场景只能用一个，已用「${scenes[0].name}」`);
  let scene = scenes[0] || null;

  if (autoMatch && prompt) {
    for (const e of mentionedIn('characters', prompt, lib)) if (!characters.includes(e)) characters.push(e);
    for (const e of mentionedIn('outfits', prompt, lib)) if (!outfits.includes(e)) outfits.push(e);
    if (!scene) scene = mentionedIn('scenes', prompt, lib)[0] || null;
    for (const e of mentionedIn('props', prompt, lib)) if (!props.includes(e)) props.push(e);
  }

  // 没指定人物，但库里只有一个：默认就是她
  if (!characters.length && (lib.characters || []).length === 1) characters.push(lib.characters[0]);

  // 服饰兜底：显式 > 今天的衣柜（日程决定）> 按情境挑 > 人物默认 > 场景默认
  // 以前没指定就永远穿 defaultOutfit（水手JK），所以每张图看着都像同一张。
  if (!outfits.length && args.wardrobe) {
    const hint = `${prompt} ${args.situation || ''} ${scene?.name || ''}`;
    const cat = /睡|床|刚醒|洗完|睡衣/.test(hint)
      ? 'sleep'
      : (/出门|便利店|河边|下楼|路上|散步|外面/.test(hint) ? 'outside' : 'home');
    const name = String(args.wardrobe[cat] || '').trim();
    const hit = name && resolveRef('outfits', name, lib);
    if (hit) outfits.push(hit);
  }
  if (!outfits.length) {
    const hint = `${prompt} ${args.situation || ''} ${scene?.name || ''}`;
    const prefer = [];
    if (/睡|床|刚醒|赖床|窝在|在家|洗澡|居家|沙发|看剧/.test(hint)) prefer.push('睡衣', '居家服');
    if (/出门|散步|便利店|河边|下楼|路上|买/.test(hint)) prefer.push('外出外套', '水手JK');
    for (const name of prefer) {
      const hit = resolveRef('outfits', name, lib);
      if (hit && !outfits.includes(hit)) { outfits.push(hit); break; }
    }
  }
  if (!outfits.length) {
    for (const c of characters) {
      const hit = c.defaultOutfit && resolveRef('outfits', c.defaultOutfit, lib);
      if (hit && !outfits.includes(hit)) outfits.push(hit);
    }
  }
  if (!outfits.length && scene?.defaultOutfit) {
    const hit = resolveRef('outfits', scene.defaultOutfit, lib);
    if (hit) outfits.push(hit);
  }

  const ordered = [...characters, ...outfits, ...(scene ? [scene] : []), ...props];
  const maxRefs = Math.max(1, Number(cfg.maxRefs) || 6);
  const refs = [];
  for (const entry of ordered) {
    const limit = entry.category === 'characters' ? Math.min(2, Number(cfg.refsPerCharacter) || 1) : 1;
    for (const img of (entry.images || []).slice(0, limit)) {
      if (refs.length >= maxRefs) break;
      refs.push({
        path: img.abs,
        label: `${LABEL[entry.category]}「${entry.name}」`
      });
    }
    if (refs.length >= maxRefs) break;
  }
  if (ordered.some((e) => e.images?.length) && refs.length >= maxRefs) {
    notes.push(`参考图达到上限 ${maxRefs} 张`);
  }

  const parts = [];
  if (String(cfg.stylePrompt || '').trim()) parts.push(`【画风】${String(cfg.stylePrompt).trim()}`);
  parts.push(`【画面】${prompt || '角色此刻的样子'}`);
  // 今天的发型由日程决定（出门/在家/睡前各一条描述）
  if (args.wardrobe) {
    const hint = `${prompt} ${args.situation || ''} ${scene?.name || ''}`;
    const cat = /睡|床|刚醒|洗完|睡衣/.test(hint)
      ? 'sleep'
      : (/出门|便利店|河边|下楼|路上|散步|外面/.test(hint) ? 'outside' : 'home');
    const hair = args.wardrobe[`hair${cat[0].toUpperCase()}${cat.slice(1)}`];
    if (hair) parts.push(`【发型】${hair}`);
  }
  for (const [key, label] of [['situation', '情境'], ['expression', '神态'], ['pose', '动作'], ['shot', '镜头'], ['light', '光线氛围']]) {
    const v = String(args[key] || '').trim();
    if (v) parts.push(`【${label}】${v}`);
  }
  // 没指定镜头/动作时自己换着来：否则每次都是"书桌+自拍近景"，看着像同一张图
  if (!String(args.shot || '').trim()) {
    const shots = ['自拍近景', '半身近景', '全身站姿', '侧后方略俯', '低头看镜头', '背对镜头回头'];
    parts.push(`【镜头】${shots[Math.floor(Math.random() * shots.length)]}`);
  }
  if (!String(args.pose || '').trim()) {
    const hint = `${prompt} ${args.situation || ''}`;
    const outside = /出门|路上|便利店|河边|下楼|散步|外面/.test(hint);
    const atHome = /在家|沙发|床|睡|窝|浴室|桌前|刚醒/.test(hint);
    const pool = outside
      ? ['边走边拍', '站在路边', '靠着栏杆', '回头看一眼']
      : atHome
        ? ['抱着靠垫', '趴在桌上', '盘腿坐着', '一只手撑着脸']
        : ['坐着', '靠着门框', '一只手撑着脸'];
    parts.push(`【动作】${pool[Math.floor(Math.random() * pool.length)]}`);
  }

  const traits = characters.filter((c) => c.traits).map((c) => `${c.name}：${oneLine(c.traits, 160)}`);
  if (traits.length) parts.push(`【人物特点】\n${traits.join('\n')}`);

  const textOnly = [];
  if (refs.length) {
    const lines = [];
    let n = 0;
    for (const entry of ordered) {
      const used = refs.filter((r) => r.label === `${LABEL[entry.category]}「${entry.name}」`);
      if (!used.length) {
        if (entry.description) textOnly.push(`${LABEL[entry.category]}「${entry.name}」：${oneLine(entry.description)}`);
        continue;
      }
      const count = used.length;
      const range = count === 1 ? `图${n + 1}` : `图${n + 1}–${n + count}`;
      n += count;
      const hint = entry.category === 'characters'
        ? '只用来确定长相：脸型五官、发型发色、瞳色、体型和标志性特征；参考图里的姿势、表情、视角、背景都不要照搬。'
        : entry.category === 'outfits'
          ? '只参考服装设计（款式、颜色、材质、细节），穿在人物身上，随动作自然起褶。'
          : entry.category === 'scenes'
            ? '只参考空间、陈设、配色和风格；镜头角度与取景按文字重新安排。'
            : '只参考外形、材质和配色。';
      lines.push(`${range}：${LABEL[entry.category]}「${entry.name}」——${hint}${entry.description ? `\n  外观：${oneLine(entry.description)}` : ''}`);
    }
    if (lines.length) parts.push(`【参考图说明（按上传顺序编号）】\n${lines.join('\n')}`);
  } else {
    for (const entry of ordered) {
      if (entry.description) textOnly.push(`${LABEL[entry.category]}「${entry.name}」：${oneLine(entry.description)}`);
    }
  }
  if (textOnly.length) parts.push(`【没有参考图、只按文字描述】\n${textOnly.join('\n')}`);
  if (refs.length) {
    parts.push('要求：画一张全新的完整画面，不要把参考图拼贴、并排或作为画中画放进去。参考图只负责长相、服装设计、场景风格和道具外形；构图、视角、景别、姿势、动作、表情、光线方向必须按上面的文字重新安排，不要照抄参考图的姿势或取景。');
  } else {
    parts.push('要求：按文字描述画一张完整画面；如果人物库有外观描述，严格按描述保持角色一致。');
  }

  return {
    prompt: parts.join('\n\n'),
    refs,
    selected: { characters, outfits, scene, props },
    notes,
    unresolved
  };
}
