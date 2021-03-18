import { DOMProxyDevtoolsEnhancer } from '../Debuggers/DOMProxyDevtoolsEnhancer'
import { installCustomObjectFormatter } from 'jsx-jsonml-devtools-renderer'
import { Emitter } from '@servie/events'

/**
 * Options for DOMProxy
 */
export interface DOMProxyOptions<Before extends Element = HTMLSpanElement, After extends Element = HTMLSpanElement> {
    /** Create the `before` node of the DOMProxy */ createBefore(): Before
    /** Create the `after` node of the DOMProxy */ createAfter(): After
    /** ShadowRootInit for creating the shadow of `before` */ beforeShadowRootInit: ShadowRootInit
    /** ShadowRootInit for creating the shadow of `after` */ afterShadowRootInit: ShadowRootInit
}
/**
 * DOMProxy provide an interface that be stable even dom is changed.
 *
 * @remarks
 *
 * DOMProxy provide 3 nodes. `before`, `current` and `after`.
 * `current` is a fake dom node powered by Proxy,
 * it will forward all your operations to the `realCurrent`.
 *
 * `before` and `after` is a true `span` that always point to before and after of `realCurrent`
 *
 * Special Handlers:
 *
 * *forward*: forward to current `realCurrent`
 *
 * *undo*: undo effect when `realCurrent` changes
 *
 * *move*: move effect to new `realCurrent`
 *
 * - style (forward, undo, move)
 * - addEventListener (forward, undo, move)
 * - appendChild (forward, undo, move)
 */
export function DOMProxy<
    ProxiedElement extends Node = HTMLElement,
    Before extends Element = HTMLSpanElement,
    After extends Element = HTMLSpanElement
>(options: Partial<DOMProxyOptions<Before, After>> = {}): DOMProxy<ProxiedElement, Before, After> {
    const event = new Emitter<DOMProxyEvents<ProxiedElement>>()
    // Options
    const { createAfter, createBefore, afterShadowRootInit, beforeShadowRootInit } = {
        ...({
            createAfter: () => document.createElement('span'),
            createBefore: () => document.createElement('span'),
            afterShadowRootInit: { mode: 'open' },
            beforeShadowRootInit: { mode: 'open' },
        } as DOMProxyOptions),
        ...options,
    } as DOMProxyOptions<Before, After>
    //
    let isDestroyed = false
    // Nodes
    let virtualBefore: Before | null = null
    let virtualBeforeShadow: ShadowRoot | null = null
    const defaultCurrent = document.createElement('div')
    let current: Node = defaultCurrent
    let virtualAfter: After | null = null
    let virtualAfterShadow: ShadowRoot | null = null
    /** All changes applied on the `proxy` */
    const changes: ActionTypes[keyof ActionTypes][] = []
    /** Read Traps */
    const readonlyTraps: ProxyHandler<any> = {
        ownKeys: () => {
            changes.push({ type: 'ownKeys', op: undefined })
            return Object.getOwnPropertyNames(current)
        },
        get: (t, key, r) => {
            changes.push({ type: 'get', op: key })
            const current_: any = current
            if (typeof current_[key] === 'function')
                return new Proxy(current_[key], {
                    apply: (target, thisArg, args) => {
                        changes.push({ type: 'callMethods', op: { name: key, param: args, thisArg } })
                        return current_[key](...args)
                    },
                })
            else if (key === 'style')
                return new Proxy((current as HTMLElement).style, {
                    set: (t, styleKey, styleValue, r) => {
                        changes.push({
                            type: 'modifyStyle',
                            op: { name: styleKey, value: styleValue, originalValue: current_.style[styleKey] },
                        })
                        current_.style[styleKey] = styleValue
                        return true
                    },
                })
            return current_[key]
        },
        has: (t, key) => {
            changes.push({ type: 'has', op: key })
            return key in current
        },
        getOwnPropertyDescriptor: (t, key) => {
            changes.push({ type: 'getOwnPropertyDescriptor', op: key })
            return Reflect.getOwnPropertyDescriptor(current, key)
        },
        isExtensible: t => {
            changes.push({ type: 'isExtensible', op: undefined })
            return Reflect.isExtensible(current)
        },
        getPrototypeOf: t => {
            changes.push({ type: 'getPrototypeOf', op: undefined })
            return Reflect.getPrototypeOf(current)
        },
    }
    /** Write Traps */
    const modifyTraps: (record: boolean) => ProxyHandler<any> = record => ({
        deleteProperty: (t, key: keyof HTMLElement) => {
            record && changes.push({ type: 'delete', op: key })
            return Reflect.deleteProperty(current, key)
        },
        set: (t, key: keyof HTMLElement, value, r) => {
            record && changes.push({ type: 'set', op: [key, value] })
            return ((current as any)[key] = value)
        },
        defineProperty: (t, key, attributes) => {
            record && changes.push({ type: 'defineProperty', op: [key, attributes] })
            return Reflect.defineProperty(current, key, attributes)
        },
        preventExtensions: t => {
            record && changes.push({ type: 'preventExtensions', op: undefined })
            return Reflect.preventExtensions(current)
        },
        setPrototypeOf: (t, prototype) => {
            record && changes.push({ type: 'setPrototypeOf', op: prototype })
            return Reflect.setPrototypeOf(current, prototype)
        },
    })
    const modifyTrapsWrite = modifyTraps(true)
    const modifyTrapsNotWrite = modifyTraps(false)
    const proxy = Proxy.revocable(defaultCurrent, { ...readonlyTraps, ...modifyTrapsWrite })
    function hasStyle(e: Node): e is HTMLElement {
        return 'style' in e
    }
    /** Call before realCurrent change */
    function undoEffects(nextCurrent?: Node | null) {
        for (const change of changes) {
            if (change.type === 'callMethods') {
                const attr: keyof HTMLElement = change.op.name as any
                if (attr === 'addEventListener') {
                    current.removeEventListener(...(change.op.param as [any, any, any]))
                } else if (attr === 'appendChild') {
                    if (!nextCurrent) {
                        const node = (change.op.thisArg as Parameters<HTMLElement['appendChild']>)[0]
                        if (node !== undefined) current.removeChild(node)
                    }
                }
            } else if (change.type === 'modifyStyle') {
                const { name, value, originalValue } = change.op
                if (hasStyle(current)) {
                    current.style[name as any] = originalValue
                }
            }
        }
    }
    /** Call after realCurrent change */
    function redoEffects() {
        if (current === defaultCurrent) return
        const t = {}
        for (const change of changes) {
            if (change.type === 'setPrototypeOf') modifyTrapsNotWrite.setPrototypeOf!(t, change.op)
            else if (change.type === 'preventExtensions') modifyTrapsNotWrite.preventExtensions!(t)
            else if (change.type === 'defineProperty')
                modifyTrapsNotWrite.defineProperty!(t, change.op[0], change.op[1])
            else if (change.type === 'set') modifyTrapsNotWrite.set!(t, change.op[0], change.op[1], t)
            else if (change.type === 'delete') modifyTrapsNotWrite.deleteProperty!(t, change.op)
            else if (change.type === 'callMethods') {
                const replayable = ['appendChild', 'addEventListener', 'before', 'after']
                const key: keyof Node = change.op.name as any
                if (replayable.indexOf(key) !== -1) {
                    if (current[key] !== undefined) {
                        ;(current[key] as any)(...change.op.param)
                    } else {
                        console.warn(current, `doesn't have method "${key}", replay failed.`)
                    }
                }
            } else if (change.type === 'modifyStyle') {
                ;(current as HTMLElement).style[change.op.name as any] = change.op.value
            }
        }
    }
    // MutationObserver
    const noop: MutationCallback = () => {}
    let observerCallback = noop
    let mutationObserverInit: MutationObserverInit | undefined = undefined
    let observer: MutationObserver | null = null
    function reObserve(reinit: boolean) {
        observer && observer.disconnect()
        if (observerCallback === noop || current === defaultCurrent) return
        if (reinit || !observer) observer = new MutationObserver(observerCallback)
        observer.observe(current, mutationObserverInit)
    }
    const DOMProxyObject = {
        observer: {
            set callback(v) {
                if (v === undefined) v = noop
                observerCallback = v
                reObserve(true)
            },
            get callback() {
                return observerCallback
            },
            get init() {
                return mutationObserverInit
            },
            set init(v) {
                mutationObserverInit = v
                reObserve(false)
            },
            get observer() {
                return observer
            },
        },
        get destroyed() {
            return isDestroyed
        },
        get before() {
            if (isDestroyed) throw new TypeError('Try to access `before` node after DOMProxy is destroyed')
            if (!virtualBefore) {
                virtualBefore = createBefore()
                if (current instanceof Element) current.before(virtualBefore)
            }
            return virtualBefore
        },
        get beforeShadow(): ShadowRoot {
            if (!virtualBeforeShadow) virtualBeforeShadow = this.before.attachShadow(beforeShadowRootInit)
            return virtualBeforeShadow
        },
        get current(): ProxiedElement {
            if (isDestroyed) throw new TypeError('Try to access `current` node after DOMProxy is destroyed')
            return proxy.proxy
        },
        get after(): After {
            if (isDestroyed) throw new TypeError('Try to access `after` node after DOMProxy is destroyed')
            if (!virtualAfter) {
                virtualAfter = createAfter()
                if (current instanceof Element) current.after(virtualAfter)
            }
            return virtualAfter
        },
        get afterShadow(): ShadowRoot {
            if (!virtualAfterShadow) virtualAfterShadow = this.after.attachShadow(afterShadowRootInit)
            return virtualAfterShadow
        },
        has(type: 'beforeShadow' | 'afterShadow' | 'before' | 'after'): any | null {
            if (type === 'before') return virtualBefore
            else if (type === 'after') return virtualAfter
            else if (type === 'afterShadow') return virtualAfterShadow
            else if (type === 'beforeShadow') return virtualBeforeShadow
            else return null
        },
        get realCurrent(): ProxiedElement | null {
            if (isDestroyed) return null
            if (current === defaultCurrent) return null
            return current as any
        },
        set realCurrent(node: ProxiedElement | null) {
            const old: ProxiedElement | null = current as any
            if (isDestroyed) throw new TypeError('You can not set current for a destroyed proxy')
            if (node === current) return
            if ((node === virtualAfter || node === virtualBefore) && node !== null) {
                console.warn(
                    "In the DOMProxy, you're setting .realCurrent to this DOMProxy's virtualAfter or virtualBefore. Doing this may cause bugs. If you're confused with this warning, check your rules for LiveSelector.",
                    this,
                )
            }
            undoEffects(node)
            if (node === null || node === undefined) {
                current = defaultCurrent
                reObserve(false)
                if (virtualBefore) virtualBefore.remove()
                if (virtualAfter) virtualAfter.remove()
            } else {
                current = node
                reObserve(false)
                if (virtualAfter && current instanceof Element) current.after(virtualAfter)
                if (virtualBefore && current instanceof Element) current.before(virtualBefore)
                redoEffects()
            }
            event.emit('currentChanged', { new: node, old })
        },
        destroy() {
            observer && observer.disconnect()
            isDestroyed = true
            proxy.revoke()
            virtualBeforeShadow = null
            virtualAfterShadow = null
            if (virtualBefore) virtualBefore.remove()
            if (virtualAfter) virtualAfter.remove()
            virtualBefore = null
            virtualAfter = null
            current = defaultCurrent
        },
    } as DOMProxy<ProxiedElement, Before, After>
    DOMProxyDevtoolsEnhancer.allDOMProxy.set(event as any, changes)
    Object.defineProperties(event, Object.getOwnPropertyDescriptors(DOMProxyObject))
    return event as any
}
DOMProxy.enhanceDebugger = function enhanceDebugger() {
    installCustomObjectFormatter(new DOMProxyDevtoolsEnhancer())
    DOMProxy.enhanceDebugger = () => {}
}
/**
 * {@inheritdoc (DOMProxy:function)}
 */
export interface DOMProxy<
    ProxiedElement extends Node = HTMLElement,
    Before extends Element = HTMLSpanElement,
    After extends Element = HTMLSpanElement
> extends Omit<Emitter<DOMProxyEvents<ProxiedElement>>, '_' | '$'> {
    /** Destroy the DOMProxy */
    destroy(): void
    readonly destroyed: boolean
    /** Returns the `before` element, if it doesn't exist, create it implicitly. */
    readonly before: Before
    /** Returns the `ShadowRoot` of the `before` element. */
    readonly beforeShadow: ShadowRoot
    /**
     * A proxy that always point to `realCurrent`,
     * and if `realCurrent` changes, all action will be forwarded to new `realCurrent`
     */
    readonly current: ProxiedElement
    /** Returns the `after` element, if it doesn't exist, create it implicitly. */
    readonly after: After
    /** Returns the `ShadowRoot` of the `after` element. */
    readonly afterShadow: ShadowRoot
    /** Get weak reference to `before` node */
    has(type: 'before'): Before | null
    /** Get weak reference to `after` node */
    has(type: 'after'): After | null
    /** Get weak reference to `beforeShadow` or `afterShadow` node */
    has(type: 'beforeShadow' | 'afterShadow'): ShadowRoot | null
    /**
     * The real current of the `current`
     */
    realCurrent: ProxiedElement | null
    /**
     * Observer for the current node.
     * You need to set callback and init to activate it.
     */
    readonly observer: {
        readonly observer: MutationObserver | null
        callback: MutationCallback | undefined
        init: MutationObserverInit | undefined
    }
}
/**
 * Events on the DOMProxy object
 */
export interface DOMProxyEvents<ProxiedElement extends Node> {
    /**
     * Emit on current changed
     * @eventProperty
     */
    currentChanged: [{ new: ProxiedElement | null; old: ProxiedElement | null }]
}

type Keys = string | number | symbol
type ActionRecord<T extends string, F> = { type: T; op: F }
interface ActionTypes {
    delete: ActionRecord<'delete', Keys>
    set: ActionRecord<'set', [Keys, any]>
    defineProperty: ActionRecord<'defineProperty', [Keys, PropertyDescriptor]>
    preventExtensions: ActionRecord<'preventExtensions', void>
    setPrototypeOf: ActionRecord<'setPrototypeOf', any>
    get: ActionRecord<'get', Keys>
    ownKeys: ActionRecord<'ownKeys', undefined>
    has: ActionRecord<'has', Keys>
    getOwnPropertyDescriptor: ActionRecord<'getOwnPropertyDescriptor', Keys>
    isExtensible: ActionRecord<'isExtensible', undefined>
    getPrototypeOf: ActionRecord<'getPrototypeOf', undefined>
    callMethods: ActionRecord<'callMethods', { name: Keys; param: any[]; thisArg: any }>
    modifyStyle: ActionRecord<'modifyStyle', { name: Keys; value: string; originalValue: string }>
}
