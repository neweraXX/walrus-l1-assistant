// Best effort across instances: signed cookies/headers carry IP-bound budgets.
// A shared process queue and IP counters provide an additional warm-instance limit.
export function createLimiter({ now = Date.now } = {}) {
  const ips = new Map(), llm = [];
  let queue = Promise.resolve();
  function reserve(ip, cost, measure, receipt = {}) {
    const time = now(), cutoff = time - 60000;
    for (const [key, value] of ips) if (value.last < cutoff) ips.delete(key);
    const entry = ips.get(ip) || { requests: [], calls: [], measure: 0, last: time };
    entry.requests = entry.requests.filter((t) => t > cutoff);
    entry.calls = [...new Set([...entry.calls, ...(receipt.ip === ip && Array.isArray(receipt.calls) ? receipt.calls : [])])].filter((t) => t > cutoff && t <= time);
    entry.measure = Math.max(entry.measure, receipt.ip === ip ? receipt.measure || 0 : 0);
    while (llm.length && llm[0] <= cutoff) llm.shift();
    const retry = measure && entry.measure > cutoff ? Math.ceil((entry.measure + 60000 - time) / 1000) : 0;
    if (entry.requests.length >= 120 || entry.calls.length + cost > 4 || llm.length + cost > 4 || retry) {
      throw Object.assign(new Error("Demo rate limit reached. Please try again shortly."), { status: 429, retryAfter: retry || 60, expose: true });
    }
    entry.requests.push(time); entry.last = time;
    // Distinct reservation stamps preserve two calls made in the same millisecond.
    for (let i = 0; i < cost; i++) {
      let stamp = time;
      while (entry.calls.includes(stamp)) stamp -= 0.001;
      entry.calls.push(stamp); llm.push(stamp);
    }
    if (measure) entry.measure = time;
    ips.set(ip, entry);
    return { ip, calls: entry.calls, measure: entry.measure };
  }
  return { reserve, enqueue(fn) { const result = queue.then(fn); queue = result.catch(() => {}); return result; } };
}
export const sharedLimiter = createLimiter();
