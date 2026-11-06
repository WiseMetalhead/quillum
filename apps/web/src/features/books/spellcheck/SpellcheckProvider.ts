import type {
  SpellcheckDictionary,
  SpellcheckLexicon,
  WorkerRequest,
  WorkerResponse,
} from './SpellcheckTypes'

const CHECK_BATCH_SIZE = 500
const INITIALIZE_TIMEOUT = 20_000
const REQUEST_TIMEOUT = 6_000

type PendingRequest = {
  resolve: (response: WorkerResponse) => void
  reject: (error: Error) => void
  timer: number
}

type RequestWithoutId = WorkerRequest extends infer Request
  ? Request extends { id: number }
    ? Omit<Request, 'id'>
    : never
  : never

export class SpellcheckProvider {
  private worker: Worker | null = null
  private sequence = 0
  private pending = new Map<number, PendingRequest>()
  private lexicon: SpellcheckLexicon | null = null
  private dictionary: SpellcheckDictionary | null = null

  private ensureWorker() {
    if (this.worker) return this.worker
    const worker = new Worker(new URL('./SpellcheckWorker.ts', import.meta.url), { type: 'module' })
    worker.onmessage = (event: MessageEvent<WorkerResponse>) => {
      const pending = this.pending.get(event.data.id)
      if (!pending) return
      window.clearTimeout(pending.timer)
      this.pending.delete(event.data.id)
      if (event.data.ok) pending.resolve(event.data)
      else pending.reject(new Error(event.data.error))
    }
    worker.onerror = () => this.failWorker(new Error('spellcheck_worker_failed'))
    this.worker = worker
    return worker
  }

  private failWorker(error: Error) {
    this.worker?.terminate()
    this.worker = null
    for (const pending of this.pending.values()) {
      window.clearTimeout(pending.timer)
      pending.reject(error)
    }
    this.pending.clear()
  }

  private request(request: RequestWithoutId, timeout = REQUEST_TIMEOUT) {
    const id = ++this.sequence
    const worker = this.ensureWorker()
    return new Promise<WorkerResponse>((resolve, reject) => {
      const timer = window.setTimeout(() => {
        this.failWorker(new Error('spellcheck_worker_timeout'))
      }, timeout)
      this.pending.set(id, { resolve, reject, timer })
      worker.postMessage({ ...request, id } as WorkerRequest)
    })
  }

  async initialize(lexicon: SpellcheckLexicon, dictionary: SpellcheckDictionary) {
    this.lexicon = lexicon
    this.dictionary = dictionary
    await this.request({ type: 'initialize', lexicon, dictionary }, INITIALIZE_TIMEOUT)
  }

  async updateLexicon(lexicon: SpellcheckLexicon) {
    this.lexicon = lexicon
    await this.request({ type: 'updateLexicon', lexicon })
  }

  private async checkBatches(words: string[]) {
    const misspelled: string[] = []
    for (let offset = 0; offset < words.length; offset += CHECK_BATCH_SIZE) {
      const response = await this.request({ type: 'check', words: words.slice(offset, offset + CHECK_BATCH_SIZE) })
      if (response.ok && response.type === 'checked') misspelled.push(...response.misspelled)
    }
    return misspelled
  }

  async check(words: string[]) {
    try {
      return await this.checkBatches(words)
    } catch (error) {
      if (!this.lexicon || !this.dictionary) throw error
      await this.request({ type: 'initialize', lexicon: this.lexicon, dictionary: this.dictionary }, INITIALIZE_TIMEOUT)
      return this.checkBatches(words)
    }
  }

  async suggest(word: string) {
    let response: WorkerResponse
    try {
      response = await this.request({ type: 'suggest', word })
    } catch (error) {
      if (!this.lexicon || !this.dictionary) throw error
      await this.request({ type: 'initialize', lexicon: this.lexicon, dictionary: this.dictionary }, INITIALIZE_TIMEOUT)
      response = await this.request({ type: 'suggest', word })
    }
    return response.ok && response.type === 'suggested' ? response.suggestions : []
  }

  terminate() {
    this.lexicon = null
    this.dictionary = null
    this.failWorker(new Error('spellcheck_worker_stopped'))
  }
}
