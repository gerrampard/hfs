import { resolve } from 'path'
import { exec, execSync } from 'child_process'
import { splitAt, try_ } from './misc'
import _ from 'lodash'
import { pid } from 'node:process'
import { promisify } from 'util'
import { IS_WINDOWS } from './const'

export function getFreeDiskSync(path: string) {
    if (IS_WINDOWS) {
        const drive = resolve(path).slice(0, 2).toUpperCase()
        const out = execSync('wmic logicaldisk get FreeSpace,name /format:list').toString().replace(/\r/g, '')
        const one = out.split(/\n\n+/).find(x => x.includes('Name=' + drive))
        if (!one)
            throw Error('miss')
        return Number(/FreeSpace=(\d+)/.exec(one)?.[1])
    }
    const out = try_(() => execSync(`df -k "${path}"`).toString(),
        err => {
            throw err.status === 1 ? Error('miss')
                : err.status === 127 ? Error('unsupported')
                    : err
        })
    if (!out?.startsWith('Filesystem'))
        throw Error('unsupported')
    const one = out.split('\n')[1]
    const free = Number(one.split(/\s+/)[3])
    return free * 1024
}

export async function getDrives() {
    const stdout = await runCmd('wmic logicaldisk get name')
    return stdout.split('\n').slice(1).map(x => x.trim()).filter(Boolean)
}

// execute win32 shell commands
export async function runCmd(cmd: string, args: string[] = []) {
    const { stdout, stderr } = await promisify(exec)(`@chcp 65001 >nul & cmd /c ${cmd} ${args.join(' ')}`, { encoding: 'utf-8' })
    return stderr || stdout
}

function getWindowsServices() {
    const fields = ['PathName', 'DisplayName', 'ProcessId'] as const
    const chunks = execSync(`wmic service get ${fields.join(',')} /value`).toString().replace(/\r/g, '').split(/\n\n+/)
    return chunks.map(chunk =>
        Object.fromEntries(chunk.split('\n').map(line => splitAt('=', line))) as { [k in typeof fields[number]]: string })
}

export const currentServiceName = IS_WINDOWS && _.find(getWindowsServices(), { ProcessId: String(pid) })?.DisplayName
