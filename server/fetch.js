// OpenRouter 中文排名镜像 · 数据管线
// 拉取 5 个端点 → 产出 data/or.json（单文件全量快照）
const fs = require('fs');
const path = require('path');
const DIR = path.join(__dirname, '..', 'data');
const KEY = process.env.OPENROUTER_API_KEY || '';

const get = async (url) => {
  const r = await fetch(url, {
    headers: {
      'Authorization': `Bearer ${KEY}`,
      'User-Agent': 'Mozilla/5.0 (zsky-openrouter-mirror)'
    },
    signal: AbortSignal.timeout(30000)
  });
  if (!r.ok) throw new Error(`${url.split('?')[0].split('/').pop()} → ${r.status}`);
  return r.json();
};

// 模型名/厂商中文化
const PROVIDER_CN = {
  'openai': 'OpenAI', 'anthropic': 'Anthropic', 'google': 'Google', 'meta-llama': 'Meta',
  'deepseek': 'DeepSeek 深度求索', 'z-ai': '智谱 AI', 'minimax': 'MiniMax 稀宇',
  'tencent': '腾讯', 'xiaomi': '小米', 'qwen': '阿里通义', 'mistralai': 'Mistral',
  'nvidia': 'NVIDIA', 'microsoft': 'Microsoft', 'cohere': 'Cohere', 'perplexity': 'Perplexity',
  'ai21': 'AI21', 'x-ai': 'xAI', 'amazon': 'Amazon', 'garak': 'Garak',
  'nousresearch': 'Nous', 'thedrummer': 'Drummer', 'sao10k': 'Sao10K', 'cognitivecomputations': 'Cognitive',
  'inception': 'Inception', 'moonshotai': '月之暗面', 'baidu': '百度', '01-ai': '零一万物',
};
const CN_PROVIDERS = new Set(['deepseek', 'z-ai', 'minimax', 'tencent', 'xiaomi', 'qwen', 'moonshotai', 'baidu', '01-ai']);
const MODEL_CN = {
  'gpt': 'GPT', 'claude': 'Claude', 'gemini': 'Gemini', 'deepseek': 'DeepSeek',
  'glm': 'GLM', 'minimax': 'MiniMax', 'hy': '混元', 'mimo': 'MiMo', 'qwen': '通义千问',
  'llama': 'Llama', 'mistral': 'Mistral', 'nemotron': 'Nemotron', 'kimi': 'Kimi',
};

function parseSlug(slug) {
  const parts = slug.split('/');
  const provider = parts[0] || '';
  const model = parts.slice(1).join('/') || slug;
  const shortName = model.replace(/-\d{6,8}$/, '').replace(/-/g, ' ').trim();
  return { provider, model, shortName };
}

function fmtTokens(n) {
  if (n >= 1e12) return (n / 1e12).toFixed(1) + 'T';
  if (n >= 1e9) return (n / 1e9).toFixed(1) + 'B';
  if (n >= 1e6) return (n / 1e6).toFixed(1) + 'M';
  return Math.round(n).toString();
}

(async () => {
  const out = { generated_at: new Date().toISOString(), errors: [] };

  // ═══ 1) Models（公开端点，无需密钥）═══
  try {
    const j = await get('https://openrouter.ai/api/v1/models');
    const models = j.data || [];
    out.models = models.map(m => ({
      id: m.id,
      name: m.name,
      desc: (m.description || '').slice(0, 100),
      promptPrice: parseFloat(m.pricing?.prompt || 0) * 1e6,       // $/M tokens
      completionPrice: parseFloat(m.pricing?.completion || 0) * 1e6,
      context: m.context_length || 0,
      modality: m.architecture?.modality || 'text',
      provider: m.id?.split('/')[0] || '',
    }));
    console.log('models:', out.models.length);
  } catch (e) { out.errors.push('models: ' + e.message) }

  // ═══ 2) Rankings Daily（核心排行榜）═══
  try {
    const j = await get(`https://openrouter.ai/api/v1/datasets/rankings-daily`);
    const rows = j.data || [];
    // 按模型聚合最近 7 天 + 计算 vs 前 7 天趋势
    const byModel = {};
    const byModelPrev = {};
    for (const r of rows) {
      const d = new Date(r.date);
      const slug = r.model_permaslug;
      const tokens = parseFloat(r.total_tokens || 0);
      const daysAgo = (Date.now() - d.getTime()) / 86400000;
      if (daysAgo <= 7) {
        byModel[slug] = (byModel[slug] || 0) + tokens;
      } else if (daysAgo <= 14) {
        byModelPrev[slug] = (byModelPrev[slug] || 0) + tokens;
      }
    }
    // 也聚合 24 小时
    const byModel24 = {};
    const latestDate = rows.length ? rows[rows.length - 1].date : '';
    for (const r of rows) {
      if (r.date === latestDate) {
        byModel24[r.model_permaslug] = parseFloat(r.total_tokens || 0);
      }
    }
    // 构建排行榜
    const modelMap = {};
    (out.models || []).forEach(m => modelMap[m.id] = m);
    out.rankings = Object.entries(byModel)
      .filter(([slug]) => slug !== 'other')
      .map(([slug, tokens]) => {
        const { provider, shortName } = parseSlug(slug);
        const prev = byModelPrev[slug] || 0;
        const trend = prev > 0 ? ((tokens - prev) / prev * 100) : (tokens > 0 ? 999 : 0);
        const m = modelMap[slug];
        return {
          slug,
          name: m?.name || shortName,
          provider,
          providerCN: PROVIDER_CN[provider] || provider,
          isCN: CN_PROVIDERS.has(provider),
          tokens,
          tokensStr: fmtTokens(tokens),
          tokens24: byModel24[slug] || 0,
          trend: Math.round(trend),
          isNew: prev === 0 && tokens > 0,
          promptPrice: m?.promptPrice || null,
          context: m?.context || null,
        };
      })
      .sort((a, b) => b.tokens - a.tokens)
      .slice(0, 50);
    // 市场份额
    const shareBy = {};
    for (const r of out.rankings) {
      const p = r.providerCN;
      shareBy[p] = (shareBy[p] || 0) + r.tokens;
    }
    const totalShare = Object.values(shareBy).reduce((a, b) => a + b, 0);
    out.marketShare = Object.entries(shareBy)
      .map(([name, tokens]) => ({ name, share: tokens / totalShare, tokens }))
      .sort((a, b) => b.tokens - a.tokens);
    console.log('rankings:', out.rankings.length, '| latest:', latestDate);
  } catch (e) { out.errors.push('rankings: ' + e.message) }

  // ═══ 3) Benchmarks（智能指数）═══
  try {
    const j = await get('https://openrouter.ai/api/v1/benchmarks?source=artificial-analysis');
    const rows = j.data || [];
    out.benchmarks = rows
      .filter(r => r.intelligence_index != null)
      .map(r => {
        const { provider, shortName } = parseSlug(r.model_permaslug || '');
        return {
          slug: r.model_permaslug,
          name: r.display_name || shortName,
          providerCN: PROVIDER_CN[provider] || provider,
          isCN: CN_PROVIDERS.has(provider),
          intelligence: r.intelligence_index,
          coding: r.coding_index,
          agentic: r.agentic_index,
          promptPrice: r.pricing?.prompt ? parseFloat(r.pricing.prompt) * 1e6 : null,
        };
      })
      .sort((a, b) => b.intelligence - a.intelligence);
    console.log('benchmarks:', out.benchmarks.length);
  } catch (e) { out.errors.push('benchmarks: ' + e.message) }

  // ═══ 4) Task Classifications（任务分布）═══
  try {
    const j = await get('https://openrouter.ai/api/v1/classifications/task?window=7d');
    const data = j.data || {};
    const cats = data.classifications || [];
    out.tasks = cats.map(c => ({
      tag: c.tag,
      name: c.display_name || c.tag,
      macro: c.macro_category || '',
      usageShare: c.usage_share || 0,
      tokenShare: c.token_share || 0,
      topModels: (c.models || []).slice(0, 3).map(m => {
        const { shortName } = parseSlug(m.model_permaslug || m.slug || '');
        return { name: m.display_name || shortName, share: m.share || 0 };
      }),
    })).sort((a, b) => b.usageShare - a.usageShare);
    console.log('tasks:', out.tasks.length);
  } catch (e) { out.errors.push('tasks: ' + e.message) }

  // ═══ 5) App Rankings（应用排行）═══
  try {
    const j = await get('https://openrouter.ai/api/v1/datasets/app-rankings?sort=popular&limit=20');
    const rows = j.data || [];
    out.apps = rows.map(r => ({
      rank: r.rank,
      name: r.app_name,
      tokens: parseFloat(r.total_tokens || 0),
      tokensStr: fmtTokens(parseFloat(r.total_tokens || 0)),
      requests: r.total_requests || 0,
    }));
    console.log('apps:', out.apps.length);
  } catch (e) { out.errors.push('apps: ' + e.message) }

  // 写文件
  fs.mkdirSync(DIR, { recursive: true });
  fs.writeFileSync(path.join(DIR, 'or.json'), JSON.stringify(out));
  const sizeKB = Math.round(JSON.stringify(out).length / 1024);
  console.log(`✓ or.json written (${sizeKB}KB) @ ${out.generated_at} | errors: ${out.errors.length}`);
})().catch(e => { console.error('FATAL', e); process.exit(1) });
