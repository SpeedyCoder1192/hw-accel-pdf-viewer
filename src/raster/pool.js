// Main-thread side of the rasterizer pool.
//
// Each worker holds its own copy of the file, so N workers rasterize N tiles
// genuinely in parallel across cores while the main thread does nothing but
// upload the results. That costs memory, hence the modest default worker count.
//
// Jobs carry a priority that the viewer rewrites as the camera moves: the tile
// under the cursor should not wait behind a tile that scrolled off-screen three
// gestures ago, so the queue is a re-sortable map rather than a FIFO.

const MAX_QUEUE = 192;

export class RasterPool {
  constructor(workerCount) {
    const cores = navigator.hardwareConcurrency || 4;
    this.size = Math.max(1, Math.min(workerCount || Math.min(3, Math.max(1, cores - 2)), 8));
    this.workers = [];
    this.queue = new Map(); // key -> job
    this.running = new Map(); // key -> { job, worker }
    this.docId = 0;
    this.opened = null;
    this.destroyed = false;
    this.stats = { rendered: 0, cancelled: 0, failed: 0 };

    for (let i = 0; i < this.size; i++) this.workers.push(this.#spawn(i));
  }

  #spawn(index) {
    // The options object has to be a static literal: Vite parses it at build
    // time to decide how to bundle the worker.
    const worker = new Worker(new URL('./raster.worker.js', import.meta.url), {
      type: 'module',
      name: 'pdf-raster',
    });
    const w = { worker, index, busy: false, ready: null, readyResolve: null, readyReject: null };
    worker.onmessage = (e) => this.#onMessage(w, e.data);
    worker.onerror = (e) => {
      w.readyReject?.(new Error(e.message || 'raster worker crashed'));
      const cur = [...this.running].find(([, r]) => r.worker === w);
      if (cur) {
        this.running.delete(cur[0]);
        cur[1].job.reject(new Error(e.message || 'raster worker crashed'));
      }
      w.busy = false;
      this.#pump();
    };
    return w;
  }

  #onMessage(w, msg) {
    switch (msg.type) {
      case 'opened':
        if (msg.id === this.docId) w.readyResolve?.({ numPages: msg.numPages });
        break;
      case 'openError':
        if (msg.id === this.docId) {
          const err = new Error(msg.message);
          err.needsPassword = msg.needsPassword;
          err.workerStack = msg.stack;
          w.readyReject?.(err);
        }
        break;
      case 'tile': {
        const run = this.running.get(msg.key);
        this.running.delete(msg.key);
        w.busy = false;
        if (run) {
          this.stats.rendered++;
          run.job.resolve({ bitmap: msg.bitmap, width: msg.width, height: msg.height });
        } else {
          msg.bitmap.close(); // cancelled after the worker had already finished
        }
        this.#pump();
        break;
      }
      case 'cancelled': {
        const run = this.running.get(msg.key);
        this.running.delete(msg.key);
        w.busy = false;
        this.stats.cancelled++;
        run?.job.reject(cancelledError());
        this.#pump();
        break;
      }
      case 'renderError': {
        const run = this.running.get(msg.key);
        this.running.delete(msg.key);
        w.busy = false;
        this.stats.failed++;
        const err = new Error(msg.message);
        err.workerStack = msg.stack;
        run?.job.reject(err);
        this.#pump();
        break;
      }
      default:
        break;
    }
  }

  /**
   * Load a document into every worker. `data` is copied per worker because
   * ArrayBuffers can only be transferred to one owner.
   */
  async open(data, password, assets) {
    const id = ++this.docId;
    this.clear();
    for (const [, run] of this.running) run.job.reject(cancelledError());
    this.running.clear();
    const results = this.workers.map((w) => {
      const copy = data.slice(0);
      const promise = new Promise((resolve, reject) => {
        w.readyResolve = resolve;
        w.readyReject = reject;
      });
      w.busy = false;
      w.worker.postMessage({ type: 'open', id, data: copy, password, assets }, [copy]);
      return promise;
    });
    const settled = await Promise.allSettled(results);
    const ok = settled.find((s) => s.status === 'fulfilled');
    if (!ok) throw settled[0].reason;
    this.opened = ok.value;
    return ok.value;
  }

  /** Queue a tile. Returns a promise that rejects with `.cancelled` if dropped. */
  submit(job) {
    if (this.running.has(job.key)) return this.running.get(job.key).job.promise;
    const existing = this.queue.get(job.key);
    if (existing) {
      existing.priority = Math.min(existing.priority, job.priority);
      return existing.promise;
    }
    let resolve, reject;
    const promise = new Promise((res, rej) => {
      resolve = res;
      reject = rej;
    });
    const entry = { ...job, resolve, reject, promise };
    this.queue.set(job.key, entry);
    this.#trim();
    this.#pump();
    return promise;
  }

  setPriority(key, priority) {
    const job = this.queue.get(key);
    if (job) job.priority = priority;
  }

  isPending(key) {
    return this.queue.has(key) || this.running.has(key);
  }

  cancel(key) {
    const queued = this.queue.get(key);
    if (queued) {
      this.queue.delete(key);
      this.stats.cancelled++;
      queued.reject(cancelledError());
      return;
    }
    const run = this.running.get(key);
    if (run) run.worker.worker.postMessage({ type: 'cancel', key });
  }

  /** Drop every queued job the predicate rejects (running jobs are left alone). */
  cancelWhere(keep) {
    for (const [key, job] of [...this.queue]) {
      if (!keep(key, job)) {
        this.queue.delete(key);
        this.stats.cancelled++;
        job.reject(cancelledError());
      }
    }
  }

  clear() {
    for (const [, job] of this.queue) job.reject(cancelledError());
    this.queue.clear();
    for (const [key, run] of this.running) {
      run.worker.worker.postMessage({ type: 'cancel', key });
    }
  }

  #trim() {
    if (this.queue.size <= MAX_QUEUE) return;
    const sorted = [...this.queue.values()].sort((a, b) => a.priority - b.priority);
    for (const job of sorted.slice(MAX_QUEUE)) {
      this.queue.delete(job.key);
      this.stats.cancelled++;
      job.reject(cancelledError());
    }
  }

  #pump() {
    if (this.destroyed) return;
    for (const w of this.workers) {
      if (w.busy || this.queue.size === 0) continue;
      let best = null;
      for (const job of this.queue.values()) {
        if (best === null || job.priority < best.priority) best = job;
      }
      if (!best) return;
      this.queue.delete(best.key);
      w.busy = true;
      this.running.set(best.key, { job: best, worker: w });
      w.worker.postMessage({
        type: 'render',
        key: best.key,
        pageIndex: best.pageIndex,
        rotation: best.rotation,
        scale: best.scale,
        ox: best.ox,
        oy: best.oy,
        width: best.width,
        height: best.height,
      });
    }
  }

  get pending() {
    return this.queue.size + this.running.size;
  }

  destroy() {
    this.destroyed = true;
    this.clear();
    for (const w of this.workers) w.worker.terminate();
    this.workers = [];
  }
}

function cancelledError() {
  const err = new Error('cancelled');
  err.cancelled = true;
  return err;
}

export const isCancelled = (err) => Boolean(err && err.cancelled);
