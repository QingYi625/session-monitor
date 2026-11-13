/**
 * Read-only parser for Antigravity conversation stats, token usage, context
 * breakdown, and compaction count.
 *
 * Primary source: <appData>/conversations/<convId>.db (SQLite via built-in node:sqlite)
 * Fallback source: <appData>/brain/<convId>/.system_generated/logs/transcript_full.jsonl
 */
import { existsSync, readFileSync, readdirSync, statSync } from 'node:fs';
import { homedir } from 'node:os';
import { basename, dirname, join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';

export const ID_RE = /^[0-9a-f-]{8,}$/i;

const STEP_USER_INPUT = 14;
const STEP_PLANNER_RESPONSE = 15;
const STEP_CHECKPOINT = 23;
const STEP_TOOL_CALL = 132;

// ---------------------------------------------------------------------------
// AppData directory discovery (matches swarm_board)
// ---------------------------------------------------------------------------

export function findAppDataDirs() {
  const dataDir = process.env.ANTIGRAVITY_EXECUTABLE_DATA_DIR;
  if (dataDir) {
    for (let d = dataDir; d !== dirname(d); d = dirname(d)) {
      if (basename(d) !== 'sidecar_data') continue;
      const appData = dirname(d);
      if (existsSync(join(appData, 'conversations')) || existsSync(join(appData, 'brain'))) {
        return [appData];
      }
      return [];
    }
  }
  const root = join(homedir(), '.gemini');
  try {
    return readdirSync(root)
      .sort()
      .map((name) => join(root, name))
      .filter((dir) => existsSync(join(dir, 'conversations')) || existsSync(join(dir, 'brain')));
  } catch {
    return [];
  }
}

function statSafe(path) {
  try {
    const s = statSync(path);
    return { exists: true, mtime: s.mtimeMs, size: s.size };
  } catch {
    return { exists: false, mtime: 0, size: -1 };
  }
}

function readTitle(appData, convId) {
  const pbtxtPath = join(appData, 'annotations', `${convId}.pbtxt`);
  try {
    const raw = readFileSync(pbtxtPath, 'utf-8');
    const m = raw.match(/title:"((?:[^"\\]|\\.)*)"/);
    if (m) {
      return JSON.parse(`"${m[1]}"`);
    }
  } catch {
    // Title is optional.
  }
  return '';
}

// ---------------------------------------------------------------------------
// Minimal BigInt-safe Protobuf wire decoder (no external dependencies)
// ---------------------------------------------------------------------------

function readVarint(buf, offset) {
  let result = 0n;
  let shift = 0n;
  let i = offset;
  while (i < buf.length) {
    const b = BigInt(buf[i++]);
    result |= (b & 0x7fn) << shift;
    if ((b & 0x80n) === 0n) {
      return { value: result, next: i };
    }
    shift += 7n;
    if (shift > 70n) break;
  }
  return null;
}

function parsePb(buf) {
  const fields = [];
  if (!buf || !buf.length) return fields;
  let i = 0;
  while (i < buf.length) {
    const tag = readVarint(buf, i);
    if (!tag) break;
    i = tag.next;
    const fieldNo = Number(tag.value >> 3n);
    const wireType = Number(tag.value & 7n);
    if (wireType === 0) {
      const val = readVarint(buf, i);
      if (!val) break;
      i = val.next;
      fields.push({ fn: fieldNo, wt: 0, val: val.value });
    } else if (wireType === 1) {
      if (i + 8 > buf.length) break;
      fields.push({ fn: fieldNo, wt: 1, val: buf.subarray(i, i + 8) });
      i += 8;
    } else if (wireType === 2) {
      const lenRes = readVarint(buf, i);
      if (!lenRes) break;
      i = lenRes.next;
      const len = Number(lenRes.value);
      if (len < 0 || i + len > buf.length) break;
      fields.push({ fn: fieldNo, wt: 2, val: buf.subarray(i, i + len) });
      i += len;
    } else if (wireType === 5) {
      if (i + 4 > buf.length) break;
      fields.push({ fn: fieldNo, wt: 5, val: buf.subarray(i, i + 4) });
      i += 4;
    } else {
      break;
    }
  }
  return fields;
}

function toSafeNum(bigVal) {
  if (typeof bigVal !== 'bigint') return Number(bigVal) || 0;
  if (bigVal > BigInt(Number.MAX_SAFE_INTEGER) || bigVal < BigInt(Number.MIN_SAFE_INTEGER)) return 0;
  return Number(bigVal);
}

function decodeTimestampSec(buf) {
  let sec = 0;
  let nanos = 0;
  for (const f of parsePb(buf)) {
    if (f.wt === 0 && f.fn === 1) sec = toSafeNum(f.val);
    else if (f.wt === 0 && f.fn === 2) nanos = toSafeNum(f.val);
  }
  if (sec > 1700000000 && sec < 2500000000) {
    return sec + nanos / 1e9;
  }
  return null;
}

function decodeDurationSec(buf) {
  let sec = 0;
  let nanos = 0;
  for (const f of parsePb(buf)) {
    if (f.wt === 0 && f.fn === 1) sec = toSafeNum(f.val);
    else if (f.wt === 0 && f.fn === 2) nanos = toSafeNum(f.val);
  }
  if (sec < 0 || sec > 86400) return null;
  return sec + nanos / 1e9;
}

function decodeUsageMsg(buf) {
  let inputTokens = 0;
  let outputTokens = 0;
  let cacheReadTokens = 0;
  let thinkingTokens = 0;
  let textTokens = 0;
  for (const f of parsePb(buf)) {
    if (f.wt !== 0) continue;
    const v = toSafeNum(f.val);
    if (f.fn === 2) inputTokens = v;
    else if (f.fn === 3) outputTokens = v;
    else if (f.fn === 5) cacheReadTokens = v;
    else if (f.fn === 9) thinkingTokens = v;
    else if (f.fn === 10) textTokens = v;
  }
  return { inputTokens, outputTokens, cacheReadTokens, thinkingTokens, textTokens };
}

function decodeStepPayload(payloadBuf) {
  let metaBuf = null;
  for (const f of parsePb(payloadBuf)) {
    if (f.fn === 5 && f.wt === 2) {
      metaBuf = f.val;
      break;
    }
  }
  if (!metaBuf) return null;

  let t1 = null;
  let t6 = null;
  let t7 = null;
  let t8 = null;
  let usage = null;

  for (const mf of parsePb(metaBuf)) {
    if (mf.wt !== 2) continue;
    if (mf.fn === 1) t1 = decodeTimestampSec(mf.val);
    else if (mf.fn === 6) t6 = decodeTimestampSec(mf.val);
    else if (mf.fn === 7) t7 = decodeTimestampSec(mf.val);
    else if (mf.fn === 8) t8 = decodeTimestampSec(mf.val);
    else if (mf.fn === 9) usage = decodeUsageMsg(mf.val);
  }

  return { t1, t6, t7, t8, usage };
}

function decodeGenMetadata(blob) {
  let rootBuf = null;
  for (const f of parsePb(blob)) {
    if (f.fn === 1 && f.wt === 2) {
      rootBuf = f.val;
      break;
    }
  }
  if (!rootBuf) return null;

  let model = '';
  let modelId = '';
  let ttftSec = null;
  let genSec = null;
  let usage = null;
  let contextUsed = null;
  let contextLimit = null;
  let sections = null;

  for (const f of parsePb(rootBuf)) {
    if (f.wt !== 2) continue;
    if (f.fn === 4) {
      usage = decodeUsageMsg(f.val);
    } else if (f.fn === 11) {
      ttftSec = decodeDurationSec(f.val);
    } else if (f.fn === 12) {
      genSec = decodeDurationSec(f.val);
    } else if (f.fn === 19) {
      modelId = Buffer.from(f.val).toString('utf-8');
    } else if (f.fn === 21) {
      model = Buffer.from(f.val).toString('utf-8');
    } else if (f.fn === 9) {
      for (const sf of parsePb(f.val)) {
        if (sf.fn === 10 && sf.wt === 2) {
          for (const cf of parsePb(sf.val)) {
            if (cf.fn === 1 && cf.wt === 0) contextUsed = toSafeNum(cf.val);
            else if (cf.fn === 4 && cf.wt === 0) contextLimit = toSafeNum(cf.val);
            else if (cf.fn === 3 && cf.wt === 2) {
              const parsedSections = {};
              for (const secWrap of parsePb(cf.val)) {
                if (secWrap.wt !== 2) continue;
                let secName = '';
                let secTokens = 0;
                for (const secF of parsePb(secWrap.val)) {
                  if (secF.fn === 1 && secF.wt === 2) {
                    secName = Buffer.from(secF.val).toString('utf-8');
                  } else if (secF.fn === 4 && secF.wt === 0) {
                    secTokens = toSafeNum(secF.val);
                  }
                }
                if (secName) {
                  parsedSections[secName] = (parsedSections[secName] || 0) + secTokens;
                }
              }
              if (Object.keys(parsedSections).length > 0) {
                sections = parsedSections;
              }
            }
          }
        }
      }
    }
  }

  return { model, modelId, ttftSec, genSec, usage, contextUsed, contextLimit, sections };
}

// ---------------------------------------------------------------------------
// Interval merging so parallel tool calls don't double-count wall time
// ---------------------------------------------------------------------------

function mergeIntervals(intervals) {
  if (!intervals.length) return 0;
  const sorted = intervals
    .filter(([a, b]) => Number.isFinite(a) && Number.isFinite(b) && b > a && (b - a) < 43200)
    .sort((x, y) => x[0] - y[0]);
  if (!sorted.length) return 0;
  let total = 0;
  let [curStart, curEnd] = sorted[0];
  for (let i = 1; i < sorted.length; i++) {
    const [s, e] = sorted[i];
    if (s <= curEnd) {
      if (e > curEnd) curEnd = e;
    } else {
      total += curEnd - curStart;
      curStart = s;
      curEnd = e;
    }
  }
  total += curEnd - curStart;
  return total;
}

// ---------------------------------------------------------------------------
// Conversation parsing (DB primary + Transcript fallback)
// ---------------------------------------------------------------------------

const statsCache = new Map(); // convId -> { key, data }

function locateConversationFiles(convId) {
  for (const appData of findAppDataDirs()) {
    const dbPath = join(appData, 'conversations', `${convId}.db`);
    const trFull = join(appData, 'brain', convId, '.system_generated', 'logs', 'transcript_full.jsonl');
    const trCompact = join(appData, 'brain', convId, '.system_generated', 'logs', 'transcript.jsonl');
    const dbStat = statSafe(dbPath);
    const walStat = statSafe(`${dbPath}-wal`);
    const trStat = statSafe(trFull).exists ? statSafe(trFull) : statSafe(trCompact);
    const trPath = statSafe(trFull).exists ? trFull : trCompact;
    if (dbStat.exists || trStat.exists) {
      return {
        appData,
        dbPath: dbStat.exists ? dbPath : null,
        dbStat,
        walStat,
        trPath: trStat.exists ? trPath : null,
        trStat,
      };
    }
  }
  return null;
}

function parseFromDb(dbPath, trPath) {
  const db = new DatabaseSync(dbPath, { readOnly: true });
  try {
    const stepRows = db.prepare('SELECT idx, step_type, status, step_payload FROM steps ORDER BY idx ASC').all();
    const gmRows = db.prepare('SELECT idx, data FROM gen_metadata ORDER BY idx ASC').all();

    let turns = 0;
    let totalSteps = stepRows.length;
    let inputTokens = 0;
    let cacheReadTokens = 0;
    let outputTokens = 0;

    const modelIntervals = [];
    const toolIntervals = [];
    const checkpointSteps = [];
    let lastObservedCtx = 0;
    let pendingCheckpoint = null;

    for (const row of stepRows) {
      const idx = Number(row.idx);
      const st = Number(row.step_type);
      if (idx + 1 > totalSteps) totalSteps = idx + 1;

      if (st === STEP_USER_INPUT) {
        turns++;
        continue;
      }

      const decoded = row.step_payload ? decodeStepPayload(row.step_payload) : null;

      if (st === STEP_PLANNER_RESPONSE || st === STEP_CHECKPOINT) {
        if (decoded?.usage) {
          inputTokens += decoded.usage.inputTokens;
          cacheReadTokens += decoded.usage.cacheReadTokens;
          outputTokens += decoded.usage.outputTokens;
          const callCtx = decoded.usage.inputTokens + decoded.usage.cacheReadTokens;
          if (pendingCheckpoint && st === STEP_PLANNER_RESPONSE && callCtx > 0) {
            pendingCheckpoint.afterTokens = callCtx;
            pendingCheckpoint = null;
          }
          if (st === STEP_PLANNER_RESPONSE && callCtx > 0) {
            lastObservedCtx = callCtx;
          }
        }
        if (decoded?.t1 && decoded?.t8 && decoded.t8 > decoded.t1) {
          modelIntervals.push([decoded.t1, decoded.t8]);
        }
        if (st === STEP_CHECKPOINT) {
          const item = {
            stepIndex: idx,
            timestamp: decoded?.t1 ? Math.round(decoded.t1 * 1000) : null,
            beforeTokens: lastObservedCtx || (decoded?.usage ? decoded.usage.inputTokens + decoded.usage.cacheReadTokens : 0),
            afterTokens: null,
          };
          checkpointSteps.push(item);
          pendingCheckpoint = item;
        }
      } else if (st === STEP_TOOL_CALL) {
        const start = decoded?.t6 || decoded?.t7 || decoded?.t1;
        const end = decoded?.t8;
        if (start && end && end >= start) {
          toolIntervals.push([start, end]);
        }
      }
    }

    // Parse gen_metadata for exact TTFT, streaming TPS, model name, and context breakdown
    let modelName = '';
    let modelId = '';
    const ttfts = [];
    let sumGenSec = 0;
    let sumGenOutput = 0;
    let sumSustainedGenSec = 0;
    let sumSustainedOutput = 0;
    let sumAllCallTimeSec = 0;
    let sumAllCallOutput = 0;
    let latestCtxUsed = null;
    let latestCtxLimit = null;
    let latestSections = null;
    let fallbackSysPrompt = 0;
    let fallbackTools = 0;

    for (const gm of gmRows) {
      const parsed = decodeGenMetadata(gm.data);
      if (!parsed) continue;
      if (parsed.model) modelName = parsed.model;
      if (parsed.modelId) modelId = parsed.modelId;
      if (parsed.ttftSec !== null && parsed.ttftSec > 0 && parsed.ttftSec < 600) {
        ttfts.push(parsed.ttftSec);
      }
      if (parsed.genSec !== null && parsed.genSec > 0.05 && parsed.usage?.outputTokens > 0) {
        sumGenSec += parsed.genSec;
        sumGenOutput += parsed.usage.outputTokens;
        if (parsed.genSec >= 0.5) {
          sumSustainedGenSec += parsed.genSec;
          sumSustainedOutput += parsed.usage.outputTokens;
        }
      }
      if (parsed.usage?.outputTokens > 0 && parsed.ttftSec !== null && parsed.genSec !== null) {
        const totalCall = parsed.ttftSec + parsed.genSec;
        if (totalCall > 0.05 && totalCall < 600) {
          sumAllCallTimeSec += totalCall;
          sumAllCallOutput += parsed.usage.outputTokens;
        }
      }
      if (parsed.contextUsed !== null) latestCtxUsed = parsed.contextUsed;
      if (parsed.contextLimit !== null) latestCtxLimit = parsed.contextLimit;
      if (parsed.sections) {
        latestSections = parsed.sections;
        if (parsed.sections['System Prompt']) fallbackSysPrompt = parsed.sections['System Prompt'];
        if (parsed.sections['Tools']) fallbackTools = parsed.sections['Tools'];
      }
    }

    // Fallback model time if step timestamps missing
    let modelTimeSec = mergeIntervals(modelIntervals);
    if (modelTimeSec === 0 && (ttfts.length || sumGenSec > 0)) {
      modelTimeSec = ttfts.reduce((a, b) => a + b, 0) + sumGenSec;
    }
    const toolTimeSec = mergeIntervals(toolIntervals);
    const avgTtftSec = ttfts.length ? ttfts.reduce((a, b) => a + b, 0) / ttfts.length : 0;
    // Prefer sustained streaming calls (>= 0.5s) to avoid single-chunk burst inflation
    const tps = sumSustainedGenSec > 0
      ? Math.round(sumSustainedOutput / sumSustainedGenSec)
      : sumGenSec > 0
        ? Math.round(sumGenOutput / sumGenSec)
        : 0;
    const endToEndTps = sumAllCallTimeSec > 0 ? Math.round(sumAllCallOutput / sumAllCallTimeSec) : 0;

    // Context breakdown
    const ctxUsed = latestCtxUsed ?? lastObservedCtx;
    const ctxLimit = latestCtxLimit || (ctxUsed > 512000 ? 1000000 : ctxUsed > 256000 ? 512000 : 256000);
    let systemPromptTokens = 0;
    let toolsTokens = 0;
    let chatMessagesTokens = 0;
    let otherTokens = 0;

    if (latestSections) {
      systemPromptTokens = latestSections['System Prompt'] || 0;
      toolsTokens = latestSections['Tools'] || 0;
      chatMessagesTokens = latestSections['Chat Messages'] || 0;
      for (const [k, v] of Object.entries(latestSections)) {
        if (k !== 'System Prompt' && k !== 'Tools' && k !== 'Chat Messages') {
          otherTokens += v;
        }
      }
    } else if (ctxUsed > 0) {
      systemPromptTokens = fallbackSysPrompt;
      toolsTokens = fallbackTools;
      chatMessagesTokens = Math.max(0, ctxUsed - systemPromptTokens - toolsTokens);
    }

    // Double-check checkpoint count against transcript if DB checkpoint payload lacked something
    if (checkpointSteps.length === 0 && trPath) {
      try {
        const txt = readFileSync(trPath, 'utf-8');
        for (const line of txt.split('\n')) {
          if (!line.includes('"CHECKPOINT"')) continue;
          const obj = JSON.parse(line);
          if (obj.type === 'CHECKPOINT') {
            checkpointSteps.push({
              stepIndex: obj.step_index ?? 0,
              timestamp: obj.created_at ? Date.parse(obj.created_at) : null,
              beforeTokens: (obj.input_tokens || 0) + (obj.cache_read_tokens || 0),
              afterTokens: null,
            });
          }
        }
      } catch {
        // Ignore transcript fallback error.
      }
    }

    const totalInput = inputTokens + cacheReadTokens;
    const totalTokens = totalInput + outputTokens;
    const cacheHitRate = totalInput > 0 ? Math.round((cacheReadTokens / totalInput) * 100) : 0;
    const contextPct = ctxLimit > 0 ? Math.min(100, Math.round((ctxUsed / ctxLimit) * 100)) : 0;

    return {
      source: 'sqlite',
      modelName: modelName || modelId || '',
      turns,
      steps: totalSteps,
      modelTimeSec,
      toolTimeSec,
      avgTtftSec,
      tps,
      endToEndTps,
      tokenUsage: {
        totalTokens,
        cacheHitRate,
        uncachedInputTokens: inputTokens,
        cacheReadTokens,
        outputTokens,
      },
      context: {
        usedTokens: ctxUsed,
        limitTokens: ctxLimit,
        pct: contextPct,
        systemPromptTokens,
        toolsTokens,
        chatMessagesTokens,
        otherTokens,
        compactionCount: checkpointSteps.length,
        compactions: checkpointSteps,
      },
    };
  } finally {
    db.close();
  }
}

function parseFromTranscript(trPath) {
  const raw = readFileSync(trPath, 'utf-8');
  let turns = 0;
  let steps = 0;
  let inputTokens = 0;
  let cacheReadTokens = 0;
  let outputTokens = 0;
  let lastCtx = 0;
  const compactions = [];
  let pendingCp = null;

  for (const line of raw.split('\n')) {
    if (!line.trim()) continue;
    let obj;
    try {
      obj = JSON.parse(line);
    } catch {
      continue;
    }
    steps++;
    if (obj.type === 'USER_INPUT') turns++;
    const inp = obj.input_tokens || 0;
    const cr = obj.cache_read_tokens || 0;
    const out = obj.output_tokens || 0;
    inputTokens += inp;
    cacheReadTokens += cr;
    outputTokens += out;

    const ctx = inp + cr;
    if (obj.type === 'PLANNER_RESPONSE' && ctx > 0) {
      if (pendingCp) {
        pendingCp.afterTokens = ctx;
        pendingCp = null;
      }
      lastCtx = ctx;
    }
    if (obj.type === 'CHECKPOINT') {
      const cp = {
        stepIndex: obj.step_index ?? steps - 1,
        timestamp: obj.created_at ? Date.parse(obj.created_at) : null,
        beforeTokens: lastCtx || ctx,
        afterTokens: null,
      };
      compactions.push(cp);
      pendingCp = cp;
    }
  }

  const totalInput = inputTokens + cacheReadTokens;
  const totalTokens = totalInput + outputTokens;
  const cacheHitRate = totalInput > 0 ? Math.round((cacheReadTokens / totalInput) * 100) : 0;
  const limitTokens = lastCtx > 512000 ? 1000000 : lastCtx > 256000 ? 512000 : 256000;
  const pct = limitTokens > 0 ? Math.min(100, Math.round((lastCtx / limitTokens) * 100)) : 0;

  return {
    source: 'transcript',
    modelName: '',
    turns,
    steps,
    modelTimeSec: 0,
    toolTimeSec: 0,
    avgTtftSec: 0,
    tps: 0,
    tokenUsage: {
      totalTokens,
      cacheHitRate,
      uncachedInputTokens: inputTokens,
      cacheReadTokens,
      outputTokens,
    },
    context: {
      usedTokens: lastCtx,
      limitTokens,
      pct,
      systemPromptTokens: 0,
      toolsTokens: 0,
      chatMessagesTokens: lastCtx,
      otherTokens: 0,
      compactionCount: compactions.length,
      compactions,
    },
  };
}

export function listRecentConversations(limit = 15) {
  const byId = new Map();
  for (const appData of findAppDataDirs()) {
    const convDir = join(appData, 'conversations');
    try {
      for (const entry of readdirSync(convDir)) {
        if (!entry.endsWith('.db')) continue;
        const id = entry.slice(0, -3);
        if (!ID_RE.test(id)) continue;
        const dbS = statSafe(join(convDir, entry));
        const walS = statSafe(join(convDir, `${entry}-wal`));
        const mtime = Math.max(dbS.mtime, walS.mtime);
        const prev = byId.get(id);
        if (!prev || mtime > prev.mtime) {
          byId.set(id, { id, mtime, title: readTitle(appData, id) || id.slice(0, 8) });
        }
      }
    } catch {
      // Ignore missing conversations dir.
    }
    const brainDir = join(appData, 'brain');
    try {
      for (const id of readdirSync(brainDir)) {
        if (!ID_RE.test(id) || byId.has(id)) continue;
        const trS = statSafe(join(brainDir, id, '.system_generated', 'logs', 'transcript_full.jsonl'));
        if (trS.exists) {
          byId.set(id, { id, mtime: trS.mtime, title: readTitle(appData, id) || id.slice(0, 8) });
        }
      }
    } catch {
      // Ignore missing brain dir.
    }
  }
  return [...byId.values()].sort((a, b) => b.mtime - a.mtime).slice(0, limit);
}

export function getConversationStats(convId) {
  if (!convId || !ID_RE.test(convId)) return null;
  const loc = locateConversationFiles(convId);
  if (!loc) return null;

  const key = `${loc.dbStat.mtime}:${loc.dbStat.size}|${loc.walStat.mtime}:${loc.walStat.size}|${loc.trStat.mtime}:${loc.trStat.size}`;
  const cached = statsCache.get(convId);
  if (cached && cached.key === key) {
    return { etag: key, ...cached.data };
  }

  let data = null;
  if (loc.dbPath) {
    try {
      data = parseFromDb(loc.dbPath, loc.trPath);
    } catch (err) {
      console.error(`[stats_panel] SQLite parse failed for ${convId}:`, err.message);
    }
  }
  if (!data && loc.trPath) {
    data = parseFromTranscript(loc.trPath);
  }
  if (!data) return null;

  data.conversationId = convId;
  data.title = readTitle(loc.appData, convId) || convId.slice(0, 8);
  data.updatedAt = Math.max(loc.dbStat.mtime, loc.walStat.mtime, loc.trStat.mtime);

  if (statsCache.size > 100) statsCache.clear();
  statsCache.set(convId, { key, data });
  return { etag: key, ...data };
}
