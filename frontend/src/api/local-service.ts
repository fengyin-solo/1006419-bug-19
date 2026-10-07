import { MODULE_BY_KEY } from '@/data/modules'
import { allRows, listRows, resetRows, saveRows } from '@/data/local-store'
import type { ActionResult, EntryRow, ModuleMeta, OverviewResult, PageResult } from '@/data/types'

// 会写进数据的「往回走」动作：命中就把这条记录标成异常态，看板上能一眼看出来。
const NEGATIVE_ACTIONS = ['撤销', '作废', '拒绝', '驳回', '停用', '忽略', '下线', '回滚']

// 垃圾池入池台账在本地存储里的键：复核通过的计量单会回写到这里，垃圾池页面底部展示。
export const PIT_INTAKE_KEY = 'pit-intake'

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

export function listEntries(key: string, filters: Record<string, string> = {}): PageResult {
  const matched = filterRows(listRows(key), filters)
  return { items: matched, total: matched.length, page: 1, size: matched.length }
}

// 详情与列表读的是同一份本地数据，按编号现取现用，不会各看各的。
export function getEntry(key: string, id: number): EntryRow | null {
  const row = listRows(key).find((item) => Number(item.id) === id)
  return row ? { ...row } : null
}

// 某条记录在当前状态下真正可执行的动作：没登记的流转边一律不出现在界面上。
export function allowedActions(key: string, status: string): string[] {
  const meta = moduleMeta(key)
  if (!meta.actionFrom) {
    return meta.actions
  }
  return meta.actions.filter((action) => (meta.actionFrom?.[action] ?? []).includes(status))
}

function formatDateTime(value: Date): string {
  const pad = (part: number) => String(part).padStart(2, '0')
  return `${value.getFullYear()}-${pad(value.getMonth() + 1)}-${pad(value.getDate())} ${pad(value.getHours())}:${pad(value.getMinutes())}`
}

// 只认「数字」或「数字+吨/t」，别的一律算无效，免得把占位文本当成有效吨位存进去。
function parseWeight(value: unknown): number | null {
  const matched = /^\s*(\d+(?:\.\d+)?)\s*(?:吨|t)?\s*$/i.exec(String(value ?? ''))
  if (!matched) {
    return null
  }
  const parsed = Number(matched[1])
  return Number.isFinite(parsed) ? parsed : null
}

function weighStamp(row: EntryRow): string {
  return String(row['过磅时间'] ?? '')
}

// 同一计量单号出现多条时，以最近一次过磅的时点为准；还没过磅的排在最后。
export function canonicalWeighbridgeRows(rows: EntryRow[]): EntryRow[] {
  const bySlip = new Map<string, EntryRow>()
  for (const row of rows) {
    const slip = String(row['计量单号'] ?? `id-${row.id}`)
    const previous = bySlip.get(slip)
    if (!previous || weighStamp(row) >= weighStamp(previous)) {
      bySlip.set(slip, row)
    }
  }
  return [...bySlip.values()]
}

// 计量页三张统计卡与运营概览共用同一口径：先按计量单号归并，再计数、再求和。
export function weighbridgeStats(rows: EntryRow[]): { label: string; value: string | number }[] {
  const canonical = canonicalWeighbridgeRows(rows)
  const today = formatDateTime(new Date()).slice(0, 10)
  const intake = canonical
    .filter((row) => String(row['过磅时间'] ?? '').slice(0, 10) === today)
    .reduce((sum, row) => sum + (parseWeight(row['净重']) ?? 0), 0)
  return [
    { label: '待过磅车辆', value: canonical.filter((row) => String(row.status) === '待过磅').length },
    { label: '已复核计量单', value: canonical.filter((row) => String(row.status) === '已复核').length },
    { label: '当日进厂量', value: `${intake.toFixed(2)} 吨` },
  ]
}

export function runAction(key: string, id: number, action: string): ActionResult {
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
  const from = meta.actionFrom?.[action]
  if (from && !from.includes(current)) {
    const locked =
      meta.actionFrom !== undefined &&
      !meta.actions.some((item) => (meta.actionFrom?.[item] ?? []).includes(current))
    if (locked) {
      return { ok: false, message: `${meta.entity}已处于「${current}」，整条锁定，任何动作都不再受理` }
    }
    return {
      ok: false,
      message: `${meta.entity}当前状态「${current}」不允许「${action}」，只有「${from.join('」「')}」能执行，跳级和回退都不认`,
    }
  }
  if (key === 'weighbridge') {
    return runWeighbridgeAction(rows, index, action, target)
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

// 计量这一环的专用流转：净重、过磅时间、复核标记必须和状态一起落库；
// 被拦下的重复过磅留在待过磅队列里并写明缘由，不能悄悄吞掉。
function runWeighbridgeAction(
  rows: EntryRow[],
  index: number,
  action: string,
  target: string,
): ActionResult {
  const row = rows[index]
  const now = formatDateTime(new Date())

  if (action === '提交过磅') {
    const gross = parseWeight(row['毛重'])
    const tare = parseWeight(row['皮重'])
    if (gross === null || tare === null) {
      return blockWeighing(rows, index, '毛重或皮重不是有效数值，净重算不出来，本次过磅未保存')
    }
    if (tare > gross) {
      return blockWeighing(
        rows,
        index,
        `皮重 ${tare.toFixed(2)} 吨大于毛重 ${gross.toFixed(2)} 吨，数据不合理，本次过磅未保存`,
      )
    }
    const plate = String(row['进场车牌'] ?? '').trim()
    const day = now.slice(0, 10)
    const duplicate = rows.find(
      (item, itemIndex) =>
        itemIndex !== index &&
        String(item['进场车牌'] ?? '').trim() === plate &&
        String(item['过磅时间'] ?? '').slice(0, 10) === day &&
        ['已过磅', '已复核'].includes(String(item.status)),
    )
    if (duplicate) {
      return blockWeighing(
        rows,
        index,
        `车牌 ${plate} 当日已按计量单 ${String(duplicate['计量单号'])} 过磅，同一时段重复提交只生效一次，本次被拦截`,
      )
    }
    const net = (gross - tare).toFixed(2)
    commitWeighbridgeRow(rows, index, {
      ...row,
      status: target,
      pending: true,
      abnormal: false,
      净重: net,
      过磅时间: now,
      计量状态: target,
      拦截缘由: '',
    })
    return {
      ok: true,
      message: `过磅完成：净重 ${net} 吨（毛重 ${gross.toFixed(2)} − 皮重 ${tare.toFixed(2)}），已随状态「已过磅」一起保存`,
    }
  }

  if (action === '确认复核') {
    const gross = parseWeight(row['毛重'])
    const tare = parseWeight(row['皮重'])
    const net = parseWeight(row['净重'])
    if (gross === null || tare === null || net === null || Math.abs(gross - tare - net) > 0.005) {
      return { ok: false, message: '净重缺失或与毛重、皮重对不上，复核不通过；请核对后重新过磅' }
    }
    const updated: EntryRow = {
      ...row,
      status: target,
      pending: false,
      abnormal: false,
      计量状态: target,
      复核时间: now,
      拦截缘由: '',
    }
    commitWeighbridgeRow(rows, index, updated)
    appendPitIntake(updated)
    return {
      ok: true,
      message: `复核完成：净重 ${net.toFixed(2)} 吨，计量单整条锁定，结果已回写垃圾池入池台账`,
    }
  }

  commitWeighbridgeRow(rows, index, {
    ...row,
    status: target,
    pending: false,
    abnormal: true,
    计量状态: target,
  })
  return { ok: true, message: `进厂计量单已标记异常，当前状态「${target}」` }
}

// 被拦下的过磅：状态不动、留在待过磅队列里，但把缘由写进记录并落库。
function blockWeighing(rows: EntryRow[], index: number, reason: string): ActionResult {
  commitWeighbridgeRow(rows, index, { ...rows[index], 拦截缘由: reason, pending: true })
  return { ok: false, message: `过磅被拦截：${reason}` }
}

function commitWeighbridgeRow(rows: EntryRow[], index: number, updated: EntryRow): void {
  const next = [...rows]
  next[index] = updated
  saveRows('weighbridge', next)
}

// 复核通过的计量单回写垃圾池入池台账；同一计量单号只入一次账。
function appendPitIntake(row: EntryRow): void {
  const ledger = listRows(PIT_INTAKE_KEY)
  if (ledger.some((entry) => String(entry['计量单号']) === String(row['计量单号']))) {
    return
  }
  const nextId = ledger.reduce((max, entry) => Math.max(max, Number(entry.id) || 0), 0) + 1
  const entry: EntryRow = {
    id: nextId,
    status: '已入池',
    pending: false,
    abnormal: false,
    台账编号: `INT-${String(nextId).padStart(4, '0')}`,
    计量单号: row['计量单号'],
    进场车牌: row['进场车牌'],
    垃圾来源: row['垃圾来源'],
    净重: row['净重'],
    过磅时间: row['过磅时间'],
    复核时间: row['复核时间'],
    入池状态: '已入池',
  }
  saveRows(PIT_INTAKE_KEY, [...ledger, entry])
}

export function listPitIntakeLedger(): EntryRow[] {
  return [...listRows(PIT_INTAKE_KEY)]
}

export function resetModule(key: string): PageResult {
  resetRows(key)
  return listEntries(key)
}

export function exportEntries(key: string): { filename: string; content: string } {
  const meta = moduleMeta(key)
  const header = ['编号', ...meta.fields, '当前状态']
  const lines = [header.join(',')]
  for (const row of listRows(key)) {
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

// 读数口径：个别模块同一单号可能不止一条，统计时先归并，保证概览和页面看到的是同一个值。
const OVERVIEW_CANONICALIZERS: Record<string, (rows: EntryRow[]) => EntryRow[]> = {
  weighbridge: canonicalWeighbridgeRows,
}

export function loadOverview(): OverviewResult {
  const rows = allRows()
  const modules = [...MODULE_BY_KEY.values()].map((meta) => {
    const stored = rows[meta.key] ?? []
    const canonicalize = OVERVIEW_CANONICALIZERS[meta.key]
    const entries = canonicalize ? canonicalize(stored) : stored
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
