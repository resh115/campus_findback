import Groq from 'groq-sdk';

const norm = (s) => String(s || '').toLowerCase().replace(/[^a-z0-9 ]/g, ' ').replace(/\s+/g, ' ').trim();
const overlap = (a, b) => {
  const A = new Set(norm(a).split(' ').filter((x) => x.length > 2));
  const B = new Set(norm(b).split(' ').filter((x) => x.length > 2));
  let n = 0;
  for (const x of A) if (B.has(x)) n++;
  return (n / Math.max(1, Math.min(A.size, B.size))) * 100;
};

function itemSimilarity(a, b) {
  const left = norm(a);
  const right = norm(b);
  if (!left || !right) return 0;
  if (left === right) return 1;
  if (left.includes(right) || right.includes(left)) return 0.85;
  return overlap(left, right) / 100;
}

function clamp(v) {
  const n = Number(v);
  return Number.isFinite(n) ? Math.max(0, Math.min(100, n)) : 0;
}

function safeJson(content) {
  try {
    return JSON.parse(content);
  } catch {
    const match = String(content || '').match(/\{[\s\S]*\}/);
    return match ? JSON.parse(match[0]) : null;
  }
}

function publicReport(report) {
  const { _visionImageData, ...clean } = report || {};
  return clean;
}

export async function matchReports(a, b) {
  let deterministic = 0;
  const factors = [];
  const add = (name, value, weight) => {
    deterministic += value * weight;
    if (value >= 0.5) factors.push(`${name}: ${Math.round(value * 100)}%`);
  };

  add('item', itemSimilarity(a.itemName, b.itemName), 0.22);
  add('category', norm(a.category) === norm(b.category) && a.category ? 1 : 0, 0.12);
  add('brand', a.brand && b.brand && norm(a.brand) === norm(b.brand) ? 1 : 0, 0.10);
  add('color', a.color && b.color && norm(a.color) === norm(b.color) ? 1 : 0, 0.10);
  add('description', overlap(a.description, b.description) / 100, 0.18);
  add('location', a.location && b.location && norm(a.location) === norm(b.location) ? 1 : overlap(a.location, b.location) / 100, 0.10);

  const da = Date.parse(a.date);
  const db = Date.parse(b.date);
  const days = Number.isFinite(da) && Number.isFinite(db) ? Math.abs(da - db) / 86400000 : 99;
  add('date', days <= 1 ? 1 : days <= 3 ? 0.7 : days <= 7 ? 0.4 : 0, 0.08);
  add('distinctive details', overlap(a.additionalInfo, b.additionalInfo) / 100, 0.10);

  const deterministicScore = Math.round(deterministic * 100);
  let textAI = null;
  let visionAI = null;
  let groq = null;

  if (process.env.GROQ_API_KEY && !/^YOUR_/.test(process.env.GROQ_API_KEY)) {
    try {
      groq = new Groq({ apiKey: process.env.GROQ_API_KEY });
      const text = await groq.chat.completions.create({
        model: process.env.GROQ_MODEL || 'openai/gpt-oss-120b',
        temperature: 0,
        response_format: { type: 'json_object' },
        messages: [
          {
            role: 'system',
            content: 'Return JSON only: {"score":number,"itemScore":number,"explanation":string,"factors":string[]}. Compare two campus lost/found reports for any kind of item, including item types not in a fixed vocabulary. Use semantic meaning to recognize synonyms, alternate names, abbreviations, brands, colors, descriptions, locations and dates. itemScore must specifically measure whether the reported objects are likely the same kind of item. Do not claim ownership. Score similarity and itemScore from 0 to 100.',
          },
          {
            role: 'user',
            content: JSON.stringify({ lostFoundA: publicReport(a), lostFoundB: publicReport(b) }),
          },
        ],
      });
      textAI = safeJson(text.choices?.[0]?.message?.content);
      if (textAI) {
        textAI.score = clamp(textAI.score);
        if (textAI.itemScore !== undefined) textAI.itemScore = clamp(textAI.itemScore);
      }
    } catch (e) {
      console.error('Groq text matching fallback:', e.message);
    }

    if (groq && a._visionImageData && b._visionImageData) {
      try {
        const vision = await groq.chat.completions.create({
          model: process.env.GROQ_VISION_MODEL || 'qwen/qwen3.8-27b',
          temperature: 0,
          response_format: { type: 'json_object' },
          messages: [
            {
              role: 'system',
              content: 'You are a visual matching engine for a campus lost-and-found system. Compare the two item photos carefully. Return JSON only: {"score":number,"explanation":string,"factors":string[]}. Score visual similarity from 0 to 100. Consider object type, shape, color, brand markings, distinctive features and visible damage. Do not claim ownership.',
            },
            {
              role: 'user',
              content: [
                { type: 'text', text: `Compare these two report images. Report A: ${JSON.stringify(publicReport(a))}\nReport B: ${JSON.stringify(publicReport(b))}` },
                { type: 'image_url', image_url: { url: a._visionImageData } },
                { type: 'image_url', image_url: { url: b._visionImageData } },
              ],
            },
          ],
        });
        visionAI = safeJson(vision.choices?.[0]?.message?.content);
        if (visionAI) visionAI.score = clamp(visionAI.score);
      } catch (e) {
        console.error('Groq vision matching fallback:', e.message);
      }
    }
  }

  const hasText = textAI && Number.isFinite(textAI.score);
  const hasVision = visionAI && Number.isFinite(visionAI.score);
  const textScore = hasText
    ? Math.round(textAI.score * 0.8 + (Number.isFinite(textAI.itemScore) ? textAI.itemScore : textAI.score) * 0.2)
    : 0;
  let score = deterministicScore;

  if (hasText && hasVision) {
    score = Math.round(deterministicScore * 0.40 + textScore * 0.35 + visionAI.score * 0.25);
  } else if (hasText) {
    score = Math.round(deterministicScore * 0.55 + textScore * 0.45);
  } else if (hasVision) {
    score = Math.round(deterministicScore * 0.55 + visionAI.score * 0.45);
  }

  const allFactors = [
    ...factors,
    ...(textAI?.factors || []).map((x) => `AI text: ${x}`),
    ...(visionAI?.factors || []).map((x) => `AI vision: ${x}`),
  ];

  let explanation = `Deterministic comparison found ${deterministicScore}% similarity across item identity, attributes, description, location and date proximity.`;
  if (hasText && hasVision) explanation = `${textAI.explanation || 'Text analysis completed.'} Visual analysis: ${visionAI.explanation || 'The images were compared.'}`;
  else if (hasText) explanation = textAI.explanation || explanation;
  else if (hasVision) explanation = `Visual analysis: ${visionAI.explanation || 'The images were compared.'}`;

  return {
    score,
    explanation,
    factors: [...new Set(allFactors)],
    ai: { text: !!hasText, vision: !!hasVision },
  };
}
