import { MODULE_BY_KEY } from '@/data/modules'
import { allRows, listRows, resetRows, saveRows } from '@/data/local-store'
import type { ActionResult, EntryRow, ModuleMeta, OverviewResult, PageResult } from '@/data/types'

// 会写进数据的「往回走」动作：命中就把这条记录标成异常态，看板上能一眼看出来。
const NEGATIVE_ACTIONS = ['撤销', '作废', '拒绝', '驳回', '停用', '忽略', '下线', '回滚']

// —— 垃圾进厂计量专用流转 ——
// 计量单生命周期：待过磅 → 已过磅 → 已复核；数据异常是旁路终态。
// 已复核的计量单整条锁住；跳级、回退、同车同时段重复过磅都在这一层挡下并写明缘由。
const WEIGHBRIDGE_KEY = 'weighbridge'
const PIT_LEDGER_KEY = 'pit-ledger'

const WEIGH_STATUS = {
  pending: '待过磅',
  weighed: '已过磅',
  reviewed: '已复核',
  abnormal: '数据异常',
} as const

// 每个动作允许发起的当前状态：不在名单里的一律拒绝，状态只准沿链条往前走。
const WEIGH_ACTION_SOURCES: Record<string, string[]> = {
  提交过磅: [WEIGH_STATUS.pending],
  确认复核: [WEIGH_STATUS.weighed],
  标记异常: [WEIGH_STATUS.pending, WEIGH_STATUS.weighed],
}

export function moduleMeta(key: string): ModuleMeta {
  const meta = MODULE_BY_KEY.get(key)
  if (!meta) {
    throw new Error(`没有登记名为 ${key} 的业务模块`)
  }
  return meta
}

export function filterRows(rows: EntryRow[], filters: Record<string, string>): EntryRow[] {
  const pairs = Object.entries(filters).filter(([, value]) => value.trim() !== '')
  if (pairs.length === 0) {
    return rows
  }
  return rows.filter((row) =>
    pairs.every(([field, value]) => String(row[field] ?? '').includes(value.trim())),
  )
}

function nowStamp(): string {
  const now = new Date()
  const pad = (value: number) => String(value).padStart(2, '0')
  const date = `${now.getFullYear()}-${pad(now.getMonth() + 1)}-${pad(now.getDate())}`
  const time = `${pad(now.getHours())}:${pad(now.getMinutes())}:${pad(now.getSeconds())}`
  return `${date} ${time}`
}

function dayOf(stamp: unknown): string {
  return String(stamp ?? '').slice(0, 10)
}

function parseWeight(value: unknown): number | null {
  const num = Number(String(value ?? '').trim())
  return Number.isFinite(num) ? num : null
}

// 同一计量单号出现多条时按冲突处理：以最近一次过磅的时点为准，其余视为脏数据剔除。
function normalizeWeighbridgeRows(rows: EntryRow[]): { rows: EntryRow[]; changed: boolean } {
  const orderKey = (row: EntryRow) => String(row['计量单号'] ?? row.id)
  const weighStamp = (row: EntryRow) => String(row['过磅时间'] ?? '')
  const latestByOrder = new Map<string, EntryRow>()
  let changed = false
  for (const row of rows) {
    const key = orderKey(row)
    const kept = latestByOrder.get(key)
    if (!kept) {
      latestByOrder.set(key, row)
      continue
    }
    changed = true
    if (weighStamp(row) > weighStamp(kept)) {
      latestByOrder.set(key, row)
    }
  }
  if (!changed) {
    return { rows, changed }
  }
  const seen = new Set<string>()
  const normalized: EntryRow[] = []
  for (const row of rows) {
    const key = orderKey(row)
    if (seen.has(key)) {
      continue
    }
    seen.add(key)
    normalized.push(latestByOrder.get(key) as EntryRow)
  }
  return { rows: normalized, changed }
}

// 计量单读取的唯一入口：先自愈再去用，列表、详情、运营概览拿到的才是同一份。
function readWeighbridgeRows(): EntryRow[] {
  const { rows, changed } = normalizeWeighbridgeRows(listRows(WEIGHBRIDGE_KEY))
  if (changed) {
    saveRows(WEIGHBRIDGE_KEY, rows)
  }
  return rows
}

// 被挡下的那条留在队列里，并把缘由写在这份记录上，不能悄悄吞掉。
function blockWithReason(rows: EntryRow[], index: number, reason: string): ActionResult {
  const next = [...rows]
  next[index] = { ...next[index], 拦截原因: reason }
  saveRows(WEIGHBRIDGE_KEY, next)
  return { ok: false, message: reason }
}

function weighOnce(rows: EntryRow[], index: number, orderNo: string): ActionResult {
  const row = rows[index]
  const gross = parseWeight(row['毛重'])
  const tare = parseWeight(row['皮重'])
  if (gross === null || tare === null || gross <= 0 || tare < 0) {
    return blockWithReason(rows, index, `计量单 ${orderNo} 的毛重/皮重不是有效数字，先补全计量数据再过磅`)
  }
  const net = Math.round((gross - tare) * 100) / 100
  if (net <= 0) {
    return blockWithReason(rows, index, `计量单 ${orderNo} 净重不大于零（毛重 ${gross} - 皮重 ${tare}），已挡下待核查`)
  }
  const stamp = nowStamp()
  // 同一辆车在同一时段（同一自然日）重复提交过磅只生效一次。
  const duplicate = rows.find(
    (other) =>
      Number(other.id) !== Number(row.id) &&
      String(other['进场车牌'] ?? '').trim() === String(row['进场车牌'] ?? '').trim() &&
      dayOf(other['过磅时间']) === dayOf(stamp) &&
      (other.status === WEIGH_STATUS.weighed || other.status === WEIGH_STATUS.reviewed),
  )
  if (duplicate) {
    return blockWithReason(
      rows,
      index,
      `计量单 ${orderNo} 与 ${String(duplicate['计量单号'])} 同车同时段重复过磅，本次提交被挡下，记录留在待过磅队列`,
    )
  }
  // 净重按毛重减皮重算出来，和状态、过磅时间一起写进同一份记录。
  const next = [...rows]
  next[index] = {
    ...row,
    status: WEIGH_STATUS.weighed,
    计量状态: WEIGH_STATUS.weighed,
    净重: net.toFixed(2),
    过磅时间: stamp,
    拦截原因: '',
    pending: true,
    abnormal: false,
  }
  saveRows(WEIGHBRIDGE_KEY, next)
  return { ok: true, message: `计量单 ${orderNo} 过磅完成，净重 ${net.toFixed(2)} 吨已随状态一起保存` }
}

// 复核结果回写垃圾池入池台账：按计量单号去重，重复回写只留最新一条。
function writePitLedger(row: EntryRow, reviewStamp: string): void {
  const ledger = listRows(PIT_LEDGER_KEY)
  const entry: EntryRow = {
    id: 0,
    status: '已入池',
    pending: false,
    abnormal: false,
    计量单号: String(row['计量单号'] ?? ''),
    进场车牌: String(row['进场车牌'] ?? ''),
    垃圾来源: String(row['垃圾来源'] ?? ''),
    净重: String(row['净重'] ?? ''),
    过磅时间: String(row['过磅时间'] ?? ''),
    复核时间: reviewStamp,
    入池时间: reviewStamp,
    台账状态: '已入池',
  }
  const existing = ledger.findIndex((item) => String(item['计量单号']) === entry['计量单号'])
  const next = [...ledger]
  if (existing >= 0) {
    entry.id = Number(ledger[existing].id)
    next[existing] = entry
  } else {
    entry.id = ledger.reduce((max, item) => Math.max(max, Number(item.id) || 0), 0) + 1
    next.push(entry)
  }
  saveRows(PIT_LEDGER_KEY, next)
}

function reviewOnce(rows: EntryRow[], index: number, orderNo: string): ActionResult {
  const row = rows[index]
  const net = parseWeight(row['净重'])
  if (net === null) {
    return blockWithReason(rows, index, `计量单 ${orderNo} 的净重没有保存成功，不能复核；请核对毛重/皮重，必要时标记异常`)
  }
  const stamp = nowStamp()
  const next = [...rows]
  next[index] = {
    ...row,
    status: WEIGH_STATUS.reviewed,
    计量状态: WEIGH_STATUS.reviewed,
    复核时间: stamp,
    拦截原因: '',
    pending: false,
    abnormal: false,
  }
  saveRows(WEIGHBRIDGE_KEY, next)
  writePitLedger(next[index], stamp)
  return { ok: true, message: `计量单 ${orderNo} 复核完成，净重 ${net.toFixed(2)} 吨已回写垃圾池入池台账` }
}

function runWeighbridgeAction(id: number, action: string): ActionResult {
  const sources = WEIGH_ACTION_SOURCES[action]
  if (!sources) {
    return { ok: false, message: `进厂计量单没有登记「${action}」这个动作` }
  }
  const rows = readWeighbridgeRows()
  const index = rows.findIndex((row) => Number(row.id) === id)
  if (index < 0) {
    return { ok: false, message: `没有找到编号为 ${id} 的进厂计量单` }
  }
  const row = rows[index]
  const orderNo = String(row['计量单号'] ?? id)
  const status = String(row.status)
  if (status === WEIGH_STATUS.reviewed) {
    return { ok: false, message: `计量单 ${orderNo} 已复核锁定，任何改动都不会生效` }
  }
  if (status === WEIGH_STATUS.abnormal) {
    return { ok: false, message: `计量单 ${orderNo} 已标记数据异常，记录已锁定，不能继续流转` }
  }
  if (!sources.includes(status)) {
    return {
      ok: false,
      message: `计量单 ${orderNo} 当前状态「${status}」，只准从待过磅一步步走到已复核，跳级和回退都不认`,
    }
  }
  if (action === '提交过磅') {
    return weighOnce(rows, index, orderNo)
  }
  if (action === '确认复核') {
    return reviewOnce(rows, index, orderNo)
  }
  const next = [...rows]
  next[index] = {
    ...row,
    status: WEIGH_STATUS.abnormal,
    计量状态: WEIGH_STATUS.abnormal,
    拦截原因: '',
    pending: false,
    abnormal: true,
  }
  saveRows(WEIGHBRIDGE_KEY, next)
  return { ok: true, message: `计量单 ${orderNo} 已标记数据异常` }
}

// 这一行当前能点哪些动作：业务口径以这里为准，页面只负责照着显示。
export function allowedActions(key: string, row: EntryRow): string[] {
  const meta = moduleMeta(key)
  if (key !== WEIGHBRIDGE_KEY) {
    return meta.actions
  }
  const status = String(row.status)
  return meta.actions.filter((action) => (WEIGH_ACTION_SOURCES[action] ?? []).includes(status))
}

// 计量页顶部三张统计卡：和列表读同一份数据，当日进厂量按过磅时间汇总净重。
export function weighbridgeSummary(rows: EntryRow[]): { label: string; value: string }[] {
  const labels = moduleMeta(WEIGHBRIDGE_KEY).metrics
  const today = dayOf(nowStamp())
  const pendingCount = rows.filter((row) => row.status === WEIGH_STATUS.pending).length
  const reviewedCount = rows.filter((row) => row.status === WEIGH_STATUS.reviewed).length
  const todayNet = rows
    .filter(
      (row) =>
        (row.status === WEIGH_STATUS.weighed || row.status === WEIGH_STATUS.reviewed) &&
        dayOf(row['过磅时间']) === today,
    )
    .reduce((sum, row) => sum + (parseWeight(row['净重']) ?? 0), 0)
  return [
    { label: labels[0] ?? '待过磅车辆', value: String(pendingCount) },
    { label: labels[1] ?? '已复核计量单', value: String(reviewedCount) },
    { label: labels[2] ?? '当日进厂量', value: `${todayNet.toFixed(2)} 吨` },
  ]
}

export function listEntries(key: string, filters: Record<string, string> = {}): PageResult {
  const source = key === WEIGHBRIDGE_KEY ? readWeighbridgeRows() : listRows(key)
  const matched = filterRows(source, filters)
  return { items: matched, total: matched.length, page: 1, size: matched.length }
}

export function getEntry(key: string, id: number): EntryRow | null {
  const rows = key === WEIGHBRIDGE_KEY ? readWeighbridgeRows() : listRows(key)
  return rows.find((row) => Number(row.id) === id) ?? null
}

export function listPitLedger(): EntryRow[] {
  return [...listRows(PIT_LEDGER_KEY)].sort((a, b) =>
    String(b['入池时间'] ?? '').localeCompare(String(a['入池时间'] ?? '')),
  )
}

export function runAction(key: string, id: number, action: string): ActionResult {
  if (key === WEIGHBRIDGE_KEY) {
    return runWeighbridgeAction(id, action)
  }
  const meta = moduleMeta(key)
  const target = meta.actionTargets[action]
  if (!target) {
    return { ok: false, message: `${meta.entity}没有登记「${action}」这个动作` }
  }
  const rows = listRows(key)
  const index = rows.findIndex((row) => Number(row.id) === id)
  if (index < 0) {
    return { ok: false, message: `没有找到编号为 ${id} 的${meta.entity}` }
  }
  const current = String(rows[index].status)
  if (current === target) {
    return { ok: false, message: `${meta.entity}已经是「${target}」，不用重复操作` }
  }
  const lastStatus = meta.statuses[meta.statuses.length - 1]
  const updated: EntryRow = {
    ...rows[index],
    status: target,
    pending: target !== lastStatus,
    abnormal: NEGATIVE_ACTIONS.some((verb) => action.startsWith(verb)),
  }
  const next = [...rows]
  next[index] = updated
  saveRows(key, next)
  return { ok: true, message: `${meta.entity}已${action}，当前状态「${target}」` }
}

export function resetModule(key: string): PageResult {
  resetRows(key)
  return listEntries(key)
}

export function exportEntries(key: string): { filename: string; content: string } {
  const meta = moduleMeta(key)
  const rows = key === WEIGHBRIDGE_KEY ? readWeighbridgeRows() : listRows(key)
  const header = ['编号', ...meta.fields, '当前状态']
  const lines = [header.join(',')]
  for (const row of rows) {
    lines.push([row.id, ...meta.fields.map((field) => row[field] ?? ''), row.status].join(','))
  }
  return { filename: `${meta.name}-清单.csv`, content: `\uFEFF${lines.join('\n')}` }
}

export function downloadEntries(key: string): void {
  const { filename, content } = exportEntries(key)
  const blob = new Blob([content], { type: 'text/csv;charset=utf-8' })
  const url = URL.createObjectURL(blob)
  const anchor = document.createElement('a')
  anchor.href = url
  anchor.download = filename
  document.body.appendChild(anchor)
  anchor.click()
  document.body.removeChild(anchor)
  URL.revokeObjectURL(url)
}

export function loadOverview(): OverviewResult {
  const rows = allRows()
  const modules = [...MODULE_BY_KEY.values()].map((meta) => {
    const entries = meta.key === WEIGHBRIDGE_KEY ? readWeighbridgeRows() : (rows[meta.key] ?? [])
    return {
      name: meta.name,
      created: entries.length,
      pending: entries.filter((row) => row.pending).length,
      abnormal: entries.filter((row) => row.abnormal).length,
    }
  })
  const cards = [
    { label: '业务模块', value: modules.length },
    { label: '登记总量', value: modules.reduce((sum, item) => sum + item.created, 0) },
    { label: '待处理', value: modules.reduce((sum, item) => sum + item.pending, 0) },
    { label: '异常量', value: modules.reduce((sum, item) => sum + item.abnormal, 0) },
  ]
  return { cards, modules }
}
