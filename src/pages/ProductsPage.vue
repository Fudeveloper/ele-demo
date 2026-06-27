<template>
  <q-page padding>
    <div class="row items-center q-mb-md q-gutter-sm">
      <div class="text-h6">商品列表</div>
      <q-space />
      <q-btn unelevated no-caps color="primary" icon="auto_awesome" label="生成图片" :disable="!selected.length" @click="onGenerate(false)" />
      <q-btn unelevated no-caps color="secondary" icon="refresh" label="重新生成" :disable="!selected.length" @click="onGenerate(true)" />
      <q-btn flat no-caps icon="price_check" label="同步价格库存" :disable="!selected.length" @click="onBatchPriceInventory" />
      <q-btn flat no-caps icon="sync_alt" label="同步SKU" :disable="!selected.length" @click="onBatchSku" />
      <q-btn flat no-caps icon="cloud_sync" label="同步WPS" :disable="!selected.length" @click="onBatchWps" />
      <q-btn flat no-caps icon="delete" color="negative" label="批量删除" :disable="!selected.length" @click="onBatchDelete" />
    </div>

    <!-- 过滤 -->
    <div class="row q-gutter-sm q-mb-md">
      <q-input v-model="filter.search" label="搜索(itemCode/名称)" outlined dense clearable debounce="300" @update:model-value="load" style="min-width: 220px" />
      <q-select v-model="filter.account_id" :options="accountOptions" label="账号" outlined dense clearable emit-value map-options @update:model-value="load" style="min-width: 180px" />
      <q-select v-model="filter.image_process_status" :options="statusOptions" label="处理状态" outlined dense clearable emit-value map-options @update:model-value="load" style="min-width: 160px" />
      <q-toggle v-model="filter.show_hidden" label="显示隐藏" @update:model-value="load" />
    </div>

    <q-table
      :rows="rows"
      :columns="columns"
      row-key="id"
      flat
      bordered
      :loading="loading"
      :rows-per-page-options="[10, 20, 50, 100]"
      :pagination="pagination"
      selection="multiple"
      v-model:selected="selected"
      @request="onRequest"
    >
      <template #body-cell-first_image="props">
        <q-td :props="props">
          <q-img v-if="props.row.first_image_url" :src="props.row.first_image_url" :ratio="1" style="width: 48px; height: 48px" fit="contain" />
        </q-td>
      </template>
      <template #body-cell-name="props">
        <q-td :props="props">
          <div class="text-weight-medium">{{ props.row.item_code }}</div>
          <div class="text-caption text-grey-7" style="max-width: 280px; white-space: nowrap; overflow: hidden; text-overflow: ellipsis">{{ props.row.product_name }}</div>
          <div v-if="props.row.sku_count > 0" class="text-caption text-blue">SKU: {{ props.row.sku_count }}</div>
        </q-td>
      </template>
      <template #body-cell-image_process_text="props">
        <q-td :props="props">
          <q-badge :color="props.row.processing_image_count > 0 ? 'orange' : (props.row.processed_image_count >= props.row.image_count ? 'green' : 'grey')">
            {{ props.row.image_process_text }}
          </q-badge>
        </q-td>
      </template>
      <template #body-cell-price="props">
        <q-td :props="props">
          <div v-if="props.row.price_inventory_failed" class="text-red text-caption">同步失败</div>
          <div v-else>
            <div>{{ props.row.price_inventory_price || '-' }}</div>
            <div class="text-caption text-grey-7">库存: {{ props.row.price_inventory_stock || '-' }}</div>
          </div>
        </q-td>
      </template>
      <template #body-cell-actions="props">
        <q-td :props="props" class="q-gutter-xs">
          <q-btn flat dense icon="image" color="primary" @click="onReview(props.row)">
            <q-tooltip>图片处理</q-tooltip>
          </q-btn>
          <q-btn flat dense icon="cloud_sync" color="secondary" @click="onWps(props.row)">
            <q-tooltip>同步WPS</q-tooltip>
          </q-btn>
          <q-btn flat dense icon="open_in_new" @click="openProduct(props.row)">
            <q-tooltip>打开商品页</q-tooltip>
          </q-btn>
          <q-btn flat dense icon="delete" color="negative" @click="onDelete(props.row)">
            <q-tooltip>删除</q-tooltip>
          </q-btn>
        </q-td>
      </template>
    </q-table>
  </q-page>
</template>

<script setup lang="ts">
import { ref, onMounted, onBeforeUnmount } from "vue";
import { useQuasar } from "quasar";

const $q = useQuasar();
const api = window.gigaApi!;

interface ProductRow {
  id: number;
  account_id: number;
  item_code: string;
  product_name: string;
  first_image_url: string;
  image_count: number;
  processed_image_count: number;
  processing_image_count: number;
  image_process_text: string;
  sku_count: number;
  price_inventory_price: string;
  price_inventory_stock: string;
  price_inventory_failed: boolean;
}

const rows = ref<ProductRow[]>([]);
const selected = ref<ProductRow[]>([]);
const loading = ref(false);
const total = ref(0);
const pagination = ref({ sortBy: "id", descending: true, page: 1, rowsPerPage: 20 });

const filter = ref({
  search: "",
  account_id: null as number | null,
  image_process_status: "" as string,
  show_hidden: false,
});

const accountOptions = ref<{ label: string; value: number }[]>([]);
const statusOptions = [
  { label: "全部已处理", value: "all_processed" },
  { label: "处理中", value: "processing" },
  { label: "未全部处理", value: "not_all_processed" },
  { label: "全未处理", value: "none_processed" },
  { label: "手动处理", value: "manually_processed" },
];

const columns = [
  { name: "first_image", label: "图", field: "first_image_url", align: "center" as const },
  { name: "name", label: "商品", field: "item_code", align: "left" as const },
  { name: "image_process_text", label: "图片处理", field: "image_process_text", align: "center" as const },
  { name: "price", label: "价格/库存", field: "price_inventory_price", align: "left" as const },
  { name: "actions", label: "操作", field: "actions", align: "center" as const },
];

async function loadAccounts() {
  const r = await api.accountsList();
  if (r.success) {
    accountOptions.value = (r.items as Array<Record<string, unknown>>).map((a) => ({
      label: String(a.account_name),
      value: Number(a.id),
    }));
  }
}

async function load() {
  loading.value = true;
  try {
    const params: Record<string, unknown> = {
      page: pagination.value.page,
      per_page: pagination.value.rowsPerPage,
    };
    if (filter.value.search) params.search = filter.value.search;
    if (filter.value.account_id) params.account_id = filter.value.account_id;
    if (filter.value.image_process_status) params.image_process_status = filter.value.image_process_status;
    if (filter.value.show_hidden) params.show_hidden = 1;
    const r = await api.productsList(params);
    if (r.success) {
      rows.value = r.items as ProductRow[];
      total.value = Number(r.total);
    }
  } finally {
    loading.value = false;
  }
}

function onRequest(props: { pagination: { page: number; rowsPerPage: number } }) {
  pagination.value.page = props.pagination.page;
  pagination.value.rowsPerPage = props.pagination.rowsPerPage;
  void load();
}

onMounted(async () => {
  await loadAccounts();
  await load();
  startPolling();
});

// 有处理中图片时轮询
let pollTimer: NodeJS.Timeout | null = null;
function startPolling() {
  pollTimer = setInterval(() => {
    if (rows.value.some((r) => r.processing_image_count > 0)) void load();
  }, 10000);
}
onBeforeUnmount(() => {
  if (pollTimer) clearInterval(pollTimer);
});

function ids() {
  return selected.value.map((r) => r.id);
}

async function onGenerate(regen: boolean) {
  const productIds = ids();
  const r = regen ? await api.imagesRegenerate({ product_ids: productIds }) : await api.imagesGenerate({ product_ids: productIds });
  if (r.success) {
    $q.notify({ type: "positive", message: "任务已创建" });
    await load();
  } else {
    $q.notify({ type: "negative", message: r.message ?? "失败" });
  }
}

async function onBatchPriceInventory() {
  $q.loading.show();
  try {
    const r = await api.productsBatchPriceInventorySync({ product_ids: ids() });
    const result = r.result as Record<string, number> | undefined;
    $q.notify({ type: r.success ? "positive" : "negative", message: r.success ? `完成 ${result?.success}/${result?.total}` : (r.message ?? "失败") });
    await load();
  } finally {
    $q.loading.hide();
  }
}

async function onBatchSku() {
  $q.loading.show();
  try {
    const r = await api.productsBatchSkuInfoSync({ product_ids: ids() });
    const result = r.result as Record<string, number> | undefined;
    $q.notify({ type: r.success ? "positive" : "negative", message: r.success ? `完成 ${result?.success}/${result?.total}` : (r.message ?? "失败") });
    await load();
  } finally {
    $q.loading.hide();
  }
}

async function onBatchWps() {
  $q.loading.show();
  try {
    const r = await api.productsBatchWpsSync({ product_ids: ids() });
    const result = r.result as Record<string, number> | undefined;
    $q.notify({ type: r.success ? "positive" : "negative", message: r.success ? `完成 ${result?.success}/${result?.total}` : (r.message ?? "失败") });
  } finally {
    $q.loading.hide();
  }
}

async function onBatchDelete() {
  $q.dialog({
    title: "确认批量删除",
    message: `删除选中的 ${selected.value.length} 个商品？`,
    ok: { color: "negative", label: "删除", unelevated: true },
    cancel: { flat: true },
  }).onOk(async () => {
    const r = await api.productsBatchDelete({ product_ids: ids() });
    if (r.success) {
      $q.notify({ type: "positive", message: "已删除" });
      selected.value = [];
      await load();
    }
  });
}

async function onDelete(row: ProductRow) {
  $q.dialog({ title: "删除商品", message: `删除 ${row.item_code}？`, ok: { color: "negative", unelevated: true }, cancel: { flat: true } }).onOk(async () => {
    await api.productsDelete(row.id);
    $q.notify({ type: "positive", message: "已删除" });
    await load();
  });
}

async function onWps(row: ProductRow) {
  $q.loading.show();
  try {
    const r = await api.productsWpsSync(row.id);
    $q.notify({ type: r.success ? "positive" : "negative", message: r.success ? "同步成功" : (r.message ?? "失败") });
  } finally {
    $q.loading.hide();
  }
}

function openProduct(row: ProductRow) {
  const url = `https://www.gigab2b.com/index.php?route=product/search&search=${encodeURIComponent(row.item_code)}`;
  window.open(url, "_blank");
}

async function onReview(row: ProductRow) {
  // 跳转到图片处理页，通过 query 传递 product_id
  const { useRouter } = await import("vue-router");
  const router = useRouter();
  void router.push({ path: "/images", query: { product_id: String(row.id) } });
}
</script>
