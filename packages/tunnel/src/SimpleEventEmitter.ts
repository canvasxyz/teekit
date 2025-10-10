interface DefaultEventMap {
  [event: string]: unknown[]
}

type EventHandler<Args extends any[] = any[]> = (...args: Args) => void

/* Simple EventEmitter polyfill, implementing the subset of Node.js 
EventEmitter needed by the tunnel library. */
export class SimpleEventEmitter<
  EventMap extends DefaultEventMap = DefaultEventMap,
> {
  private listeners = new Map<string | symbol, Set<EventHandler>>()
  private onceListeners = new Map<string | symbol, Set<EventHandler>>()

  on<K extends keyof EventMap>(
    event: K,
    handler: EventHandler<EventMap[K]>,
  ): this
  on(event: string | symbol, handler: EventHandler): this
  on(event: string | symbol, handler: EventHandler): this {
    if (!this.listeners.has(event)) {
      this.listeners.set(event, new Set())
    }
    this.listeners.get(event)!.add(handler)
    return this
  }

  once<K extends keyof EventMap>(
    event: K,
    handler: EventHandler<EventMap[K]>,
  ): this
  once(event: string | symbol, handler: EventHandler): this
  once(event: string | symbol, handler: EventHandler): this {
    if (!this.onceListeners.has(event)) {
      this.onceListeners.set(event, new Set())
    }
    this.onceListeners.get(event)!.add(handler)
    return this
  }

  emit<K extends keyof EventMap>(event: K, ...args: EventMap[K]): boolean
  emit(event: string | symbol, ...args: any[]): boolean
  emit(event: string | symbol, ...args: any[]): boolean {
    let called = false

    // Call regular listeners
    const handlers = this.listeners.get(event)
    if (handlers) {
      handlers.forEach((handler) => {
        try {
          handler(...args)
          called = true
        } catch (error) {
          console.error(`Error in event handler for "${String(event)}":`, error)
        }
      })
    }

    // Call and remove once listeners
    const onceHandlers = this.onceListeners.get(event)
    if (onceHandlers) {
      onceHandlers.forEach((handler) => {
        try {
          handler(...args)
          called = true
        } catch (error) {
          console.error(
            `Error in once event handler for "${String(event)}":`,
            error,
          )
        }
      })
      this.onceListeners.delete(event)
    }

    return called
  }

  removeListener<K extends keyof EventMap>(
    event: K,
    handler: EventHandler<EventMap[K]>,
  ): this
  removeListener(event: string | symbol, handler: EventHandler): this
  removeListener(event: string | symbol, handler: EventHandler): this {
    const handlers = this.listeners.get(event)
    if (handlers) {
      handlers.delete(handler)
      if (handlers.size === 0) {
        this.listeners.delete(event)
      }
    }

    const onceHandlers = this.onceListeners.get(event)
    if (onceHandlers) {
      onceHandlers.delete(handler)
      if (onceHandlers.size === 0) {
        this.onceListeners.delete(event)
      }
    }

    return this
  }

  off<K extends keyof EventMap>(
    event: K,
    handler: EventHandler<EventMap[K]>,
  ): this
  off(event: string | symbol, handler: EventHandler): this
  off(event: string | symbol, handler: EventHandler): this {
    return this.removeListener(event, handler)
  }

  removeAllListeners(event?: string | symbol): this {
    if (event === undefined) {
      this.listeners.clear()
      this.onceListeners.clear()
    } else {
      this.listeners.delete(event)
      this.onceListeners.delete(event)
    }
    return this
  }

  listenerCount(event: string | symbol): number {
    const regular = this.listeners.get(event)?.size ?? 0
    const once = this.onceListeners.get(event)?.size ?? 0
    return regular + once
  }

  eventNames(): (string | symbol)[] {
    const names = new Set<string | symbol>()
    this.listeners.forEach((_, key) => names.add(key))
    this.onceListeners.forEach((_, key) => names.add(key))
    return Array.from(names)
  }
}
