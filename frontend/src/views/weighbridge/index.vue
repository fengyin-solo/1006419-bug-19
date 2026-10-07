<template>
  <section class="page" data-module="weighbridge">
    <header class="page-head">
      <div>
        <h2>垃圾进厂计量管理</h2>
        <p class="page-desc">维护进厂计量单，围绕计量单号、进场车牌、垃圾来源、毛重做登记、筛选与状态流转。</p>
      </div>
      <div class="page-actions">
        <button class="btn primary" type="button" @click="openCreate">登记进厂计量单</button>
        <button class="btn" type="button" @click="exportRows">导出垃圾进厂计量清单</button>
      </div>
    </header>

    <div class="stat-row">
      <article v-for="item in stats" :key="item.label" class="stat-card">
        <span class="stat-label">{{ item.label }}</span>
        <strong class="stat-value">{{ item.value }}</strong>
      </article>
    </div>

    <p v-if="noticeMessage" class="banner notice">{{ noticeMessage }}</p>
    <p v-if="errorMessage" class="banner error">{{ errorMessage }}</p>

    <p class="status-legend">
      <span v-for="item in statusSummary" :key="item.status" class="legend-item">
        {{ item.status }}：{{ item.count }}
      </span>
    </p>

    <form class="filter-bar" @submit.prevent="reload">
      <label v-for="field in filterFields" :key="field" class="filter-item">
        <span>{{ field }}</span>
        <input v-model="filters[field]" :placeholder="`按${field}检索`" />
      </label>
      <button class="btn" type="submit">查询</button>
      <button class="btn ghost" type="button" @click="resetFilters">重置条件</button>
    </form>

    <table class="data-table">
      <thead>
        <tr>
          <th v-for="column in columns" :key="column">{{ column }}</th>
          <th>当前状态</th>
          <th>可执行动作</th>
        </tr>
      </thead>
      <tbody>
        <tr v-for="row in rows" :key="String(row.id)">
          <td v-for="column in columns" :key="column">{{ cellText(row, column) }}</td>
          <td>{{ row.status }}</td>
          <td class="row-actions">
            <button
              v-for="action in rowActions(row)"
              :key="action"
              class="link"
              type="button"
              @click="runAction(action, row)"
            >
              {{ action }}
            </button>
            <span v-if="!rowActions(row).length" class="locked-text">{{ lockLabel(row) }}</span>
            <button class="link" type="button" @click="openDetail(row)">详情</button>
          </td>
        </tr>
        <tr v-if="!rows.length">
          <td :colspan="columns.length + 2" class="empty-state">暂无垃圾进厂计量数据，可先登记进厂计量单</td>
        </tr>
      </tbody>
    </table>

    <aside v-if="detail" class="detail-panel">
      <header class="detail-head">
        <h3>计量单详情：{{ detail['计量单号'] }}</h3>
        <button class="btn ghost" type="button" @click="closeDetail">关闭</button>
      </header>
      <dl class="detail-grid">
        <div v-for="item in detailItems" :key="item.label" class="detail-item">
          <dt>{{ item.label }}</dt>
          <dd>{{ item.value }}</dd>
        </div>
      </dl>
    </aside>

    <footer class="page-foot">
      <span>共 {{ total }} 条垃圾进厂计量记录</span>
    </footer>
  </section>
</template>

<script setup lang="ts">
import { computed, onMounted, ref } from 'vue'

import {
  allowedActions,
  downloadEntries,
  getEntry,
  listEntries,
  moduleMeta,
  runAction as applyAction,
  weighbridgeStats,
} from '@/api/local-service'
import type { EntryRow } from '@/data/types'

const meta = moduleMeta('weighbridge')
const columns = ["计量单号", "进场车牌", "垃圾来源", "毛重", "皮重", "净重", "过磅时间", "计量状态", "拦截缘由"]
const statuses = ["待过磅", "已过磅", "已复核", "数据异常"]

const rows = ref<EntryRow[]>([])
const total = ref(0)
const errorMessage = ref('')
const noticeMessage = ref('')
const filters = ref<Record<string, string>>({})
const filterFields = columns.slice(0, 3)
const detail = ref<EntryRow | null>(null)

// 统计卡与运营概览共用同一归并口径：同一计量单号冲突时以最近一次过磅的时点为准。
const stats = computed(() => weighbridgeStats(rows.value))
const statusSummary = computed(() =>
  statuses.map((status: string) => ({
    status,
    count: rows.value.filter((row) => String(row.status) === status).length,
  })),
)

const detailItems = computed(() => {
  if (!detail.value) {
    return []
  }
  const row = detail.value
  const items: { label: string; value: string | number | boolean }[] = [
    { label: '编号', value: row.id },
    ...meta.fields.map((field) => ({ label: field, value: cellText(row, field) })),
    { label: '当前状态', value: row.status },
  ]
  if (row['复核时间']) {
    items.push({ label: '复核时间', value: String(row['复核时间']) })
  }
  return items
})

function cellText(row: EntryRow, field: string): string {
  return String(row[field] ?? '') || '—'
}

function rowActions(row: EntryRow): string[] {
  return allowedActions(meta.key, String(row.status))
}

function lockLabel(row: EntryRow): string {
  return String(row.status) === '已复核' ? '已复核·整条锁定' : '已终结·不再受理'
}

function resetFilters() {
  filters.value = {}
  reload()
}

function exportRows() {
  downloadEntries(meta.key)
}

function openCreate() {
  errorMessage.value = '进厂计量单登记入口尚未接入审批流'
}

function openDetail(row: EntryRow) {
  detail.value = getEntry(meta.key, Number(row.id))
}

function closeDetail() {
  detail.value = null
}

function runAction(action: string, row: EntryRow) {
  errorMessage.value = ''
  noticeMessage.value = ''
  const result = applyAction(meta.key, Number(row.id), action)
  if (result.ok) {
    noticeMessage.value = result.message
  } else {
    errorMessage.value = result.message
  }
  // 不管成败都刷新：被拦截的那条要把写下的缘由显示出来。
  reload()
}

function reload() {
  try {
    const payload = listEntries(meta.key, filters.value)
    rows.value = payload.items
    total.value = payload.total
    if (detail.value) {
      detail.value = getEntry(meta.key, Number(detail.value.id))
    }
  } catch (error) {
    errorMessage.value = error instanceof Error ? error.message : '垃圾进厂计量列表读取失败'
  }
}

onMounted(reload)
</script>
