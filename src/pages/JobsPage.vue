<template>
  <q-page padding>
    <div class="row items-center q-mb-md">
      <div class="text-h6">任务记录</div>
      <q-space />
      <q-btn flat no-caps icon="refresh" label="刷新" @click="load" />
    </div>

    <q-table
      :rows="rows"
      :columns="columns"
      row-key="id"
      flat
      bordered
      :loading="loading"
      :rows-per-page-options="[20, 50, 100]"
    >
      <template #body-cell-status="props">
        <q-td :props="props">
          <q-badge :color="statusColor(props.row.status)">{{ statusLabel(props.row.status) }}</q-badge>
        </q-td>
      </template>
      <template #body-cell-progress="props">
        <q-td :props="props">
          <q-linear-progress
            :value="props.row.total ? props.row.processed / props.row.total : 0"
            color="primary"
            class="q-mt-xs"
          />
          <div class="text-caption">{{ props.row.success_count }} 成功 / {{ props.row.fail_count }} 失败 / {{ props.row.total }} 总计</div>
        </q-td>
      </template>
      <template #body-cell-logs="props">
        <q-td :props="props">
          <q-expansion-item dense dense-toggle :label="`${props.row.logs ? props.row.logs.split('\n').length : 0} 行日志`">
            <pre class="text-caption" style="max-height: 200px; overflow: auto; white-space: pre-wrap">{{ props.row.logs }}</pre>
          </q-expansion-item>
        </q-td>
      </template>
    </q-table>
  </q-page>
</template>

<script setup lang="ts">
import { ref, onMounted, onBeforeUnmount } from "vue";

const api = window.gigaApi!;

interface JobRow {
  id: number;
  job_type: string;
  status: string;
  total: number;
  processed: number;
  success_count: number;
  fail_count: number;
  message: string;
  logs: string;
  duration_ms: number;
  created_at: number;
  finished_at: number | null;
}

const rows = ref<JobRow[]>([]);
const loading = ref(false);

const columns = [
  { name: "id", label: "ID", field: "id", align: "center" as const },
  { name: "job_type", label: "类型", field: "job_type", align: "left" as const },
  { name: "status", label: "状态", field: "status", align: "center" as const },
  { name: "progress", label: "进度", field: "progress", align: "left" as const },
  { name: "message", label: "消息", field: "message", align: "left" as const },
  { name: "duration_ms", label: "耗时(秒)", field: (r: JobRow) => (r.duration_ms / 1000).toFixed(1), align: "center" as const },
  { name: "logs", label: "日志", field: "logs", align: "left" as const },
];

function statusColor(s: string): string {
  switch (s) {
    case "succeeded": return "green";
    case "running": return "blue";
    case "pending": return "grey";
    case "partial_failed": return "orange";
    case "failed": return "red";
    default: return "grey";
  }
}
function statusLabel(s: string): string {
  return { succeeded: "成功", running: "运行中", pending: "等待", partial_failed: "部分失败", failed: "失败" }[s] ?? s;
}

async function load() {
  loading.value = true;
  try {
    const r = await api.jobsList();
    if (r.success) rows.value = r.items as JobRow[];
  } finally {
    loading.value = false;
  }
}

onMounted(() => {
  void load();
  timer = setInterval(load, 5000);
});

let timer: NodeJS.Timeout | null = null;
onBeforeUnmount(() => {
  if (timer) clearInterval(timer);
});
</script>
