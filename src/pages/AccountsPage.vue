<template>
  <q-page padding>
    <div class="row items-center q-mb-md">
      <div class="text-h6">账号管理</div>
      <q-space />
      <q-btn flat no-caps icon="upload_file" label="导入CSV" @click="onImportCsv" class="q-mr-sm" />
      <q-btn unelevated no-caps color="primary" icon="add" label="新增账号" @click="onCreate" />
    </div>

    <q-table
      :rows="rows"
      :columns="columns"
      row-key="id"
      flat
      bordered
      :loading="loading"
      :rows-per-page-options="[0]"
    >
      <template #body-cell-enabled="props">
        <q-td :props="props">
          <q-toggle
            :model-value="!!props.row.enabled"
            @update:model-value="(v) => onToggleEnabled(props.row, v)"
          />
        </q-td>
      </template>
      <template #body-cell-actions="props">
        <q-td :props="props" class="q-gutter-xs">
          <q-btn flat dense icon="science" color="info" @click="onTest(props.row)">
            <q-tooltip>测活</q-tooltip>
          </q-btn>
          <q-btn flat dense icon="sync" color="primary" @click="onSync(props.row, false)">
            <q-tooltip>同步新收藏</q-tooltip>
          </q-btn>
          <q-btn flat dense icon="cloud_download" color="secondary" @click="onSync(props.row, true)">
            <q-tooltip>全量同步</q-tooltip>
          </q-btn>
          <q-btn flat dense icon="edit" @click="onEdit(props.row)">
            <q-tooltip>编辑</q-tooltip>
          </q-btn>
          <q-btn flat dense icon="delete" color="negative" @click="onDelete(props.row)">
            <q-tooltip>删除</q-tooltip>
          </q-btn>
        </q-td>
      </template>
    </q-table>

    <!-- 新增/编辑弹窗 -->
    <q-dialog v-model="formDialog">
      <q-card style="min-width: 480px">
        <q-card-section class="text-h6">{{ editing ? "编辑账号" : "新增账号" }}</q-card-section>
        <q-card-section class="q-gutter-md">
          <q-input v-model="form.account_name" label="账号名称" outlined />
          <q-input v-model="form.appid" label="AppID" outlined :disable="editing" />
          <q-input v-model="form.secret" label="Secret" outlined type="password" />
          <q-input v-model="form.cookie" label="Cookie" outlined type="textarea" autogrow />
          <q-input v-model="form.remark" label="备注" outlined />
        </q-card-section>
        <q-card-actions align="right">
          <q-btn flat label="取消" v-close-popup />
          <q-btn unelevated color="primary" label="保存" @click="onSave" />
        </q-card-actions>
      </q-card>
    </q-dialog>
  </q-page>
</template>

<script setup lang="ts">
import { ref, onMounted } from "vue";
import { useQuasar } from "quasar";

const $q = useQuasar();
const api = window.gigaApi!;

interface AccountRow {
  id: number;
  account_name: string;
  appid: string;
  secret: string;
  cookie: string;
  remark: string;
  enabled: boolean;
  product_count: number;
  last_synced_at: string;
  last_validated_at: string;
}

const rows = ref<AccountRow[]>([]);
const loading = ref(false);

const columns = [
  { name: "account_name", label: "账号", field: "account_name", align: "left" as const },
  { name: "appid", label: "AppID", field: "appid", align: "left" as const },
  { name: "product_count", label: "商品数", field: "product_count", align: "center" as const },
  { name: "last_synced_at", label: "最近同步", field: "last_synced_at", align: "left" as const },
  { name: "last_validated_at", label: "最近测活", field: "last_validated_at", align: "left" as const },
  { name: "enabled", label: "启用", field: "enabled", align: "center" as const },
  { name: "actions", label: "操作", field: "actions", align: "center" as const },
];

async function load() {
  loading.value = true;
  try {
    const r = await api.accountsList();
    if (r.success) rows.value = r.items as AccountRow[];
    else $q.notify({ type: "negative", message: r.message ?? "加载失败" });
  } finally {
    loading.value = false;
  }
}

onMounted(load);

const formDialog = ref(false);
const editing = ref(false);
const form = ref({ id: 0, account_name: "", appid: "", secret: "", cookie: "", remark: "" });

function onCreate() {
  editing.value = false;
  form.value = { id: 0, account_name: "", appid: "", secret: "", cookie: "", remark: "" };
  formDialog.value = true;
}

function onEdit(row: AccountRow) {
  editing.value = true;
  form.value = { id: row.id, account_name: row.account_name, appid: row.appid, secret: "", cookie: "", remark: row.remark };
  formDialog.value = true;
}

async function onSave() {
  const f = form.value;
  if (!f.appid || !f.secret) {
    $q.notify({ type: "negative", message: "appid 和 secret 为必填" });
    return;
  }
  const payload: Record<string, unknown> = { account_name: f.account_name, secret: f.secret, cookie: f.cookie, remark: f.remark };
  if (!editing.value) payload.appid = f.appid;
  const r = editing.value
    ? await api.accountsReplace(f.id, payload)
    : await api.accountsCreate(payload);
  if (r.success) {
    $q.notify({ type: "positive", message: "保存成功" });
    formDialog.value = false;
    await load();
  } else {
    $q.notify({ type: "negative", message: r.message ?? "保存失败" });
  }
}

async function onToggleEnabled(row: AccountRow, v: boolean | string | number | null) {
  const r = await api.accountsUpdate(row.id, { enabled: !!v });
  if (r.success) {
    row.enabled = !!v;
  } else {
    $q.notify({ type: "negative", message: r.message ?? "更新失败" });
  }
}

async function onDelete(row: AccountRow) {
  $q.dialog({
    title: "确认删除",
    message: `确定删除账号「${row.account_name}」？相关商品也会被删除。`,
    ok: { color: "negative", label: "删除", unelevated: true },
    cancel: { flat: true, label: "取消" },
  }).onOk(async () => {
    const r = await api.accountsDelete(row.id);
    if (r.success) {
      $q.notify({ type: "positive", message: "已删除" });
      await load();
    } else {
      $q.notify({ type: "negative", message: r.message ?? "删除失败" });
    }
  });
}

async function onTest(row: AccountRow) {
  $q.loading.show({ message: "测活中..." });
  try {
    const r = await api.accountsTest(row.id);
    if (r.success) {
      const result = (r.result as { status: string; message: string }) ?? {};
      $q.notify({ type: "positive", message: result.message ?? "测活成功" });
    } else {
      $q.notify({ type: "negative", message: r.message ?? "测活失败" });
    }
  } finally {
    $q.loading.hide();
  }
}

async function onSync(row: AccountRow, full: boolean) {
  $q.loading.show({ message: full ? "全量同步中..." : "同步新收藏中..." });
  try {
    const r = await api.accountsSync(row.id, { full });
    $q.notify({ type: r.success ? "positive" : "negative", message: (r.message ?? (r.success ? "成功" : "同步失败")) });
    await load();
  } finally {
    $q.loading.hide();
  }
}

function onImportCsv() {
  const input = document.createElement("input");
  input.type = "file";
  input.accept = ".csv,text/csv";
  input.onchange = async () => {
    const file = input.files?.[0];
    if (!file) return;
    const text = await file.text();
    $q.loading.show({ message: "导入中..." });
    try {
      const r = await api.accountsImportCsv(text);
      if (r.success) {
        const s = r.summary as Record<string, number>;
        $q.notify({ type: "positive", message: `导入完成：新增 ${s.created}，更新 ${s.updated}，失败 ${s.failed}` });
        await load();
      } else {
        $q.notify({ type: "negative", message: r.message ?? "导入失败" });
      }
    } finally {
      $q.loading.hide();
    }
  };
  input.click();
}
</script>
