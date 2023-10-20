// This file is part of HFS - Copyright 2021-2023, Massimo Melina <a@rejetto.com> - License https://www.gnu.org/licenses/gpl-3.0.txt

import { getNodeName, isSameFilenameAs, nodeIsDirectory, saveVfs, urlToNode, vfs, VfsNode, applyParentToChild,
    permsFromParent } from './vfs'
import _ from 'lodash'
import { stat, unlink, writeFile } from 'fs/promises'
import { ApiError, ApiHandlers, SendListReadable } from './apiMiddleware'
import { dirname, extname, join, resolve } from 'path'
import { dirStream, enforceFinal, isDirectory, isWindowsDrive, makeMatcher, PERM_KEYS, VfsNodeAdminSend } from './misc'
import {
    IS_WINDOWS,
    HTTP_BAD_REQUEST, HTTP_NOT_FOUND, HTTP_SERVER_ERROR, HTTP_CONFLICT, HTTP_NOT_ACCEPTABLE,
} from './const'
import { getDrives } from './util-os'
import { Stats } from 'fs'
import { getBaseUrlOrDefault, getServerStatus } from './listen'
import { homedir } from 'os'
import open from 'open'

// to manipulate the tree we need the original node
async function urlToNodeOriginal(uri: string) {
    const n = await urlToNode(uri)
    return n?.isTemp ? n.original : n
}

const apis: ApiHandlers = {

    async get_vfs() {
        return { root: await recur() }

        async function recur(node=vfs): Promise<VfsNodeAdminSend> {
            const { source } = node
            const stats: false | Stats = Boolean(source) && await stat(source!).catch(() => false)
            const isDir = !source || stats && stats.isDirectory()
            const copyStats: Pick<VfsNodeAdminSend, 'size' | 'ctime' | 'mtime'> = stats ? _.pick(stats, ['size', 'ctime', 'mtime'])
                : { size: source ? -1 : undefined }
            if (copyStats.mtime && Number(copyStats.mtime) === Number(copyStats.ctime))
                delete copyStats.mtime
            const inherited = node.parent && permsFromParent(node.parent, node.original || node)
            const byMasks = node.original && _.pickBy(node, (v,k) =>
                v !== (node.original as any)[k] // something is changing me...
                && !(inherited && k in inherited) // ...and it's not inheritance...
                && PERM_KEYS.includes(k as any)) // ...must be masks. Please limit this to perms
            return {
                ...copyStats,
                ...node.original || node,
                inherited,
                byMasks: _.isEmpty(byMasks) ? undefined : byMasks,
                website: Boolean(node.children?.find(isSameFilenameAs('index.html')))
                    || isDir && source && await stat(join(source, 'index.html')).then(() => true, () => undefined)
                    || undefined,
                name: node === vfs ? '' : getNodeName(node),
                type: isDir ? 'folder' : undefined,
                children: node.children && await Promise.all(node.children.map(child =>
                    recur(applyParentToChild(child, node)) ))
            }
        }
    },

    async move_vfs({ from, parent }) {
        if (!from || !parent)
            return new ApiError(HTTP_BAD_REQUEST)
        const fromNode = await urlToNodeOriginal(from)
        if (!fromNode)
            return new ApiError(HTTP_NOT_FOUND, 'from not found')
        if (fromNode === vfs)
            return new ApiError(HTTP_BAD_REQUEST, 'from is root')
        const parentNode = await urlToNodeOriginal(parent)
        if (!parentNode)
            return new ApiError(HTTP_NOT_FOUND, 'parent not found')
        const name = getNodeName(fromNode)
        if (parentNode.children?.find(x => name === getNodeName(x)))
            return new ApiError(HTTP_CONFLICT, 'item with same name already present in destination')
        const oldParent = await urlToNodeOriginal(dirname(from))
        _.pull(oldParent!.children!, fromNode)
        if (_.isEmpty(oldParent!.children))
            delete oldParent!.children
        ;(parentNode.children ||= []).push(fromNode)
        await saveVfs()
        return {}
    },

    async set_vfs({ uri, props }) {
        const n = await urlToNodeOriginal(uri)
        if (!n)
            return new ApiError(HTTP_NOT_FOUND, 'path not found')
        props = pickProps(props, ['name','source','masks','default','accept', ...PERM_KEYS]) // sanitize
        if (props.name && props.name !== getNodeName(n)) {
            const parent = await urlToNodeOriginal(dirname(uri))
            if (parent?.children?.find(x => getNodeName(x) === props.name))
                return new ApiError(HTTP_CONFLICT, 'name already present')
        }
        if (props.masks && typeof props.masks !== 'object')
            delete props.masks
        Object.assign(n, props)
        simplifyName(n)
        await saveVfs()
        return n
    },

    async add_vfs({ parent, source, name }) {
        if (!source && !name)
            return new ApiError(HTTP_BAD_REQUEST, 'name or source required')
        const parentNode = parent ? await urlToNodeOriginal(parent) : vfs
        if (!parentNode)
            return new ApiError(HTTP_NOT_FOUND, 'parent not found')
        if (!await nodeIsDirectory(parentNode))
            return new ApiError(HTTP_NOT_ACCEPTABLE, 'parent not a folder')
        if (isWindowsDrive(source))
            source += '\\' // slash must be included, otherwise it will refer to the cwd of that drive
        const isDir = source && await isDirectory(source)
        if (source && isDir === undefined)
            return new ApiError(HTTP_NOT_FOUND, 'source not found')
        const child = { source, name }
        name = getNodeName(child) // could be not given as input
        const ext = extname(name)
        const noExt = ext ? name.slice(0, -ext.length) : name
        let idx = 2
        while (parentNode.children?.find(isSameFilenameAs(name)))
            name = `${noExt} ${idx++}${ext}`
        child.name = name
        simplifyName(child)
        ;(parentNode.children ||= []).unshift(child)
        await saveVfs()
        const link = getBaseUrlOrDefault()
            + (parent ? enforceFinal('/', parent) : '/')
            + encodeURIComponent(getNodeName(child))
            + (isDir ? '/' : '')
        return { name, link }
    },

    async del_vfs({ uris }) {
        if (!uris || !Array.isArray(uris))
            return new ApiError(HTTP_BAD_REQUEST, 'invalid uris')
        return {
            errors: await Promise.all(uris.map(async uri => {
                if (typeof uri !== 'string')
                    return HTTP_BAD_REQUEST
                if (uri === '/')
                    return HTTP_NOT_ACCEPTABLE
                const node = await urlToNodeOriginal(uri)
                if (!node)
                    return HTTP_NOT_FOUND
                const parent = dirname(uri)
                const parentNode = await urlToNodeOriginal(parent)
                if (!parentNode) // shouldn't happen
                    return HTTP_SERVER_ERROR
                const { children } = parentNode
                if (!children) // shouldn't happen
                    return HTTP_SERVER_ERROR
                const idx = children.indexOf(node)
                children.splice(idx, 1)
                saveVfs()
                return 0 // error code 0 is OK
            }))
        }
    },

    get_cwd() {
        return { path: process.cwd() }
    },

    async resolve_path({ path, closestFolder }) {
        path = resolve(path)
        if (closestFolder)
            while (path && !await isDirectory(path))
                path = dirname(path)
        return { path }
    },

    get_ls({ path, files=true, fileMask }, ctx) {
        return new SendListReadable({
            async doAtStart(list) {
                if (!path && IS_WINDOWS) {
                    try {
                        for (const n of await getDrives())
                            list.add({ n, k: 'd' })
                    } catch (error) {
                        console.debug(error)
                    }
                    return
                }
                try {
                    const matching = makeMatcher(fileMask)
                    path = isWindowsDrive(path) ? path + '\\' : resolve(path || '/')
                    for await (const [name, isDir] of dirStream(path)) {
                        if (ctx.req.aborted)
                            return
                        if (!isDir)
                            if (!files || fileMask && !matching(name))
                                continue
                        try {
                            const stats = await stat(join(path, name))
                            list.add({
                                n: name,
                                s: stats.size,
                                c: stats.ctime,
                                m: stats.mtime,
                                k: isDir ? 'd' : undefined,
                            })
                        } catch {} // just ignore entries we can't stat
                    }
                    list.close()
                } catch (e: any) {
                    list.error(e.code || e.message || String(e), true)
                }
            }
        })
    },

    async windows_integration() {
        return { finish: await windowsIntegration() }
    },

}

export default apis

// pick only selected props, and consider null and empty string as undefined
function pickProps(o: any, keys: string[]) {
    const ret: any = {}
    if (o && typeof o === 'object')
        for (const k of keys)
            if (k in o)
                ret[k] = o[k] === null || o[k] === '' ? undefined : o[k]
    return ret
}

function simplifyName(node: VfsNode) {
    const { name, ...noName } = node
    if (getNodeName(noName) === name)
        delete node.name
}

async function windowsIntegration() {
    const status = await getServerStatus()
    const url = 'http://localhost:' + status.http.port
    const content = `Windows Registry Editor Version 5.00
        `+ ['*', 'Directory'].map(k => `
[HKEY_CLASSES_ROOT\\${k}\\shell\\AddToHFS3]
@="Add to HFS (new)"

[HKEY_CLASSES_ROOT\\${k}\\shell\\AddToHFS3\\command]
@="powershell -Command \\"$p = '%1'.Replace('\\\\', '\\\\\\\\'); $j = '{ \\\\\\"source\\\\\\": \\\\\\"' + $p + '\\\\\\" }';  $wsh = New-Object -ComObject Wscript.Shell; try { $res = Invoke-WebRequest -Uri '${url}/~/api/add_vfs' -Method POST -Headers @{ 'x-hfs-anti-csrf' = '1' } -ContentType 'application/json' -TimeoutSec 1 -Body $j; $json = $res.Content | ConvertFrom-Json; $link = $json.link; $link | Set-Clipboard; } catch { $wsh.Popup('Server is down', 0, 'Error', 16); }\\""
    `)
    const path = homedir() + '\\desktop\\hfs-windows-menu.reg'
    await writeFile(path, content, 'utf8')
    try {
        await open(path, { wait: true})
        await unlink(path)
    }
    catch { return path }
}