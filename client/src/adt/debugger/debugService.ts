import {
    ADTClient, Debuggee, DebugStepType, isDebuggerBreakpoint,
    debugMetaIsComplex, isDebugListenerError, session_types, DebugMetaType, DebugVariable, DebugBreakpoint, DebuggingMode
} from "abap-adt-api"
import { newClientFromKey, md5 } from "./functions"
import { readFileSync, writeFileSync, existsSync, mkdirSync } from "fs"
import { log } from "../../lib"
import { DebugProtocol } from "vscode-debugprotocol"
import { Disposable, EventEmitter, Uri } from "vscode"
import { getRoot } from "../conections"
import { isAbapFile, } from "abapfs"
import { homedir } from "os"
import { join } from "path"
import { Breakpoint, Handles, Scope, Source, StoppedEvent } from "vscode-debugadapter"
import { vsCodeUri } from "../../langClient"
import { v1 } from "uuid"
import { getWinRegistryReader } from "./winregistry"

const ATTACHTIMEOUT = "autoAttachTimeout"

export interface RequestTerminationEvent {
    event: "adtrequesttermination"
}
export const isRequestTerminationEvent = (e: any): e is RequestTerminationEvent => e?.event === "adtrequesttermination"
const requestTermination = (): RequestTerminationEvent => ({ event: "adtrequesttermination" })

export interface DebuggerUI {
    Confirmator: (message: string) => Thenable<boolean>
    ShowError: (message: string) => any
}
interface Variable {
    id: string,
    name: string,
    meta?: DebugMetaType,
    lines?: number
}

const variableValue = (v: DebugVariable) => {
    if (v.META_TYPE === "table") return `${v.TECHNICAL_TYPE || v.META_TYPE} ${v.TABLE_LINES} lines`
    if (debugMetaIsComplex(v.META_TYPE)) return v.META_TYPE
    return `${v.VALUE}`
}

const getOrCreateTerminalId = async () => {
    if (process.platform === "win32") {
        const reg = getWinRegistryReader()
        const terminalId = reg && reg("HKEY_CURRENT_USER", "Software\\SAP\\ABAP Debugging", "TerminalID")
        if (!terminalId) throw new Error("Unable to read terminal ID from windows registry")
        return terminalId
    } else {
        const cfgpath = join(homedir(), ".SAP/ABAPDebugging")
        const cfgfile = join(cfgpath, "terminalId")
        try {
            return readFileSync(cfgfile).toString("utf8")
        } catch (error) {
            const terminalId = v1().replace(/-/g, "").toUpperCase()
            if (!existsSync(cfgpath)) mkdirSync(cfgpath, { recursive: true })
            writeFileSync(cfgfile, terminalId)
            return terminalId
        }
    }
}

interface StackFrame extends DebugProtocol.StackFrame {
    stackPosition: number
    stackUri?: string
}

class AdtBreakpoint extends Breakpoint {
    constructor(verified: boolean, readonly adtBp?: DebugBreakpoint, line?: number, column?: number, source?: Source) {
        super(verified, line, column, source)
    }
}

const errorType = (err: any) => {
    const exceptionType = err?.properties?.["com.sap.adt.communicationFramework.subType"]
    if (!exceptionType && `${err.response.body}`.match(/Connection timed out/)) return ATTACHTIMEOUT
    return exceptionType

}

// tslint:disable-next-line:max-classes-per-file
export class DebugService {
    private active: boolean = false
    private attached: boolean = false
    private killed = false
    private ideId: string
    private notifier: EventEmitter<DebugProtocol.Event | RequestTerminationEvent> = new EventEmitter()
    private listeners: Disposable[] = []
    private stackTrace: StackFrame[] = []
    private currentStackId?: number
    private breakpoints = new Map<string, AdtBreakpoint[]>()
    private variableHandles = new Handles<Variable>()
    private readonly mode: DebuggingMode
    public readonly THREADID = 1
    private doRefresh?: NodeJS.Timeout
    private get client() {
        if (this.killed) throw new Error("Disconnected")
        return this._client
    }

    constructor(private connId: string, private _client: ADTClient, private terminalId: string,
        private username: string, terminalMode: boolean, private ui: DebuggerUI) {
        this.ideId = md5(connId)
        this.mode = terminalMode ? "terminal" : "user"
        if (!this.username) this.username = _client.username.toUpperCase()
    }
    addListener(listener: (e: DebugProtocol.Event | RequestTerminationEvent) => any, thisArg?: any) {
        return this.notifier.event(listener, thisArg, this.listeners)
    }

    getStack() {
        return this.stackTrace
    }

    async getScopes(frameId: number) {
        this.variableHandles.reset()
        const currentStack = this.stackTrace.find(s => s.id === frameId)
        if (currentStack && !isNaN(currentStack.stackPosition) && frameId !== this.currentStackId) {
            await this.client.debuggerGoToStack(currentStack.stackUri || currentStack.stackPosition)
            this.currentStackId = frameId
        }
        const { hierarchies } = await this.client.debuggerChildVariables(["@ROOT"])
        const scopes = hierarchies.map(h => {
            const name = h.CHILD_NAME || h.CHILD_ID
            const handler = this.variableHandles.create({ id: h.CHILD_ID, name })
            return new Scope(name, handler, true)
        })
        return scopes
    }

    private async childVariables(parent: Variable) {
        if (parent.meta === "table") {
            if (!parent.lines) return []
            const keys = [...Array(parent.lines).keys()].map(k => `${parent.id.replace(/\[\]$/, "")}[${k + 1}]`)
            return this.client.debuggerVariables(keys)
        }
        return this.client.debuggerChildVariables([parent.id]).then(r => r.variables)
    }

    async evaluate(expression: string) {
        const v = await this.client.debuggerVariables([expression])
        if (!v[0]) return
        const variablesReference = this.variableHandles.create({ id: v[0].ID, name: v[0].NAME, lines: v[0].TABLE_LINES, meta: v[0].META_TYPE })
        return { result: variableValue(v[0]), variablesReference }
    }

    async getVariables(parentid: number) {
        const vari = this.variableHandles.get(parentid)
        if (vari) {
            const children = await this.childVariables(vari)
            const variables: DebugProtocol.Variable[] = children.map(v => ({
                name: `${v.NAME}`,
                value: variableValue(v),
                variablesReference: debugMetaIsComplex(v.META_TYPE) ?
                    this.variableHandles.create({ name: v.NAME, id: v.ID, meta: v.META_TYPE, lines: v.TABLE_LINES })
                    : 0,
                memoryReference: `${v.ID}`
            }))
            return variables
        }
        return []
    }

    public static async create(connId: string, ui: DebuggerUI, username: string, terminalMode: boolean) {
        const client = await newClientFromKey(connId)
        if (!client) throw new Error(`Unable to create client for${connId}`)
        client.stateful = session_types.stateful
        await client.adtCoreDiscovery()
        const terminalId = await getOrCreateTerminalId()
        return new DebugService(connId, client, terminalId, username, terminalMode, ui)
    }

    private stopListener(norestart = true) {
        if (norestart) {
            this.active = false
        }
        const c = this._client.statelessClone
        return c.debuggerDeleteListener(this.mode, this.terminalId, this.ideId, this.username)
    }

    public async mainLoop() {
        this.active = true
        while (this.active) {
            try {
                const c = this._client.statelessClone
                const debuggee = await c.debuggerListen(this.mode, this.terminalId, this.ideId, this.username)
                if (!debuggee || !this.active) continue
                if (isDebugListenerError(debuggee)) {
                    // reconnect
                    break
                }
                await this.onBreakpointReached(debuggee)
            } catch (error) {
                if (!this.active) return
                // autoAttachTimeout
                const exceptionType = errorType(error)
                switch (exceptionType) {
                    case "conflictNotification":
                    case "conflictDetected":
                        const txt = error?.properties?.conflictText || "Debugger conflict detected"
                        const message = `${txt} Take over debugging?`
                        // const resp = await window.showQuickPick(["YES", "NO"], { placeHolder })
                        const resp = await this.ui.Confirmator(message)
                        if (resp)
                            try {
                                await this.stopListener(false)
                            } catch (error2) {
                                log(JSON.stringify(error2))
                            }
                        else {
                            this.refresh()
                            this.stopDebugging()
                        }
                        break
                    case ATTACHTIMEOUT:
                        this.refresh()
                        break
                    default:
                        this.ui.ShowError(`Error listening to debugger: ${error.message || error}`)
                        this.stopDebugging()
                }
            }
        }
    }

    public getBreakpoints(path: string) {
        return this.breakpoints.get(path) || []
    }
    public async setBreakpoints(source: DebugProtocol.Source, breakpoints: DebugProtocol.SourceBreakpoint[]) {
        const bps = await this.setBreakpointsInt(source, breakpoints)
        if (source.path) this.breakpoints.set(source.path, bps)
        return bps
    }

    private async setBreakpointsInt(source: DebugProtocol.Source, breakpoints: DebugProtocol.SourceBreakpoint[]) {
        breakpoints ||= []
        if (!source.path) return []
        const uri = Uri.parse(source.path)
        const root = getRoot(this.connId)
        const node = await root.getNodeAsync(uri.path)
        if (isAbapFile(node)) {
            const objuri = node.object.contentsPath()
            const clientId = `24:${this.connId}${uri.path}` // `582:/A4H_001_developer_en/.adt/programs/programs/ztest/ztest.asprog`
            const bps = breakpoints.map(b => `${objuri}#start=${b.line}`)
            try {
                const actualbps = await this.client.debuggerSetBreakpoints(this.mode, this.terminalId, this.ideId, clientId, bps, this.username)
                const confirmed = breakpoints.map(bp => {
                    const actual = actualbps.find(a => isDebuggerBreakpoint(a) && a.uri.range.start.line === bp.line)
                    if (actual && isDebuggerBreakpoint(actual)) {
                        const src = new Source(source.name || "", source.path)
                        return new AdtBreakpoint(true, actual, bp.line, 0, src)
                    }
                    return new AdtBreakpoint(false)
                })
                return confirmed
            } catch (error) {
                log(error.message)
            }
        }
        return []

    }

    private async onBreakpointReached(debuggee: Debuggee) {
        try {
            if (!this.attached)
                await this.client.debuggerAttach(this.mode, debuggee.DEBUGGEE_ID, this.username, true)
            this.attached = true
            await this.client.debuggerSaveSettings({})
            await this.updateStack()
            this.notifier.fire(new StoppedEvent("breakpoint", this.THREADID))
            this.doRefresh = setTimeout(() => this.refresh(), 60000)
        } catch (error) {
            log(`${error}`)
            this.stopDebugging()
        }
    }
    refresh(): void {
        this.doRefresh = undefined
        this.client.debuggerVariables(["SY-SUBRC"]).catch(() => undefined)
    }

    private async baseDebuggerStep(stepType: DebugStepType, url?: string) {
        if (stepType === "stepRunToLine" || stepType === "stepJumpToLine") {
            if (!url) throw new Error(`Bebugger step${stepType} requires a target`)
            return this.client.debuggerStep(stepType, url)
        }
        return this.client.debuggerStep(stepType)
    }

    public async debuggerStep(stepType: DebugStepType, url?: string) {
        try {
            if (this.doRefresh) clearTimeout(this.doRefresh)
            this.doRefresh = undefined
            const res = await this.baseDebuggerStep(stepType, url)
            await this.updateStack()
            this.notifier.fire(new StoppedEvent("breakpoint", this.THREADID))
            return res
        } catch (error) {
            if (error?.properties?.["com.sap.adt.communicationFramework.subType"] === "debuggeeEnded") {
                await this.client.dropSession()
                this.client.stateful = session_types.stateful
                await this.client.adtCoreDiscovery()
                this.attached = false
            } else
                this.ui.ShowError(error?.message || "unknown error in debugger stepping")
        }
    }

    private async updateStack() {
        const stackInfo = await this.client.debuggerStackTrace(false).catch(() => undefined)
        this.currentStackId = 0
        const createFrame = (path: string, line: number, id: number, stackPosition: number, stackUri?: string) => {
            const name = path.replace(/.*\//, "")
            const source = new Source(name, path)
            const frame: StackFrame = { id, name, source, line, column: 0, stackPosition }
            return frame
        }
        if (stackInfo) {
            const stackp = stackInfo.stack.map(async (s, id) => {
                try {
                    const path = await vsCodeUri(this.connId, s.uri.uri, true, true)
                    const stackUri = "stackUri" in s ? s.stackUri : undefined
                    return createFrame(path, s.line, id, s.stackPosition, stackUri)
                } catch (error) {
                    log(error)
                    return createFrame("unknown", 0, id, NaN)
                }
            })
            // @ts-ignore
            this.stackTrace = (await Promise.all(stackp)).filter(s => !!s)
        }
    }

    public stopDebugging() {
        this.active = false
        this.notifier.fire(requestTermination())
    }
    public async logout() {
        const ignore = () => undefined
        const wasactive = this.active
        this.active = false
        this.attached = false
        if (this.killed) return
        const client = this.client
        const delbp = (bp: DebugBreakpoint) =>
            client.debuggerDeleteBreakpoints(bp, this.mode, this.terminalId, this.ideId, this.username)
        const deleteBreakpoints = async (source: string) => {
            const dels = this.breakpoints.get(source)?.map(async b => b.adtBp && delbp(b.adtBp))
            return Promise.all(dels || [])
        }
        const proms: Promise<any>[] = [...this.breakpoints.keys()].map(deleteBreakpoints)
        this.killed = true
        const stop = wasactive ? this.stopListener().catch(ignore) : Promise.resolve()
        proms.push(stop)
        if (client.loggedin)
            proms.push(stop.then(() => client.dropSession().catch(ignore).then(() => client.logout().catch(ignore))))
        await Promise.all(proms)
    }
}
