<template>
  <q-page padding>
    <div class="row items-center q-mb-md q-gutter-sm">
      <div class="text-h6">图片处理工作台</div>
      <q-space />
      <q-select
        v-model="currentProductId"
        :options="productOptions"
        label="选择商品"
        outlined
        dense
        emit-value
        map-options
        style="min-width: 300px"
        @update:model-value="loadImages"
      />
    </div>

    <div v-if="!currentProductId" class="text-grey-7 q-pa-lg text-center">
      请从左侧商品列表进入，或在上方选择一个商品。
    </div>

    <div v-else>
      <div class="row items-center q-mb-md q-gutter-sm">
        <q-btn unelevated no-caps color="primary" icon="auto_awesome" label="生成全部未处理" @click="() => onGenerate()" />
        <q-btn flat no-caps icon="flip" label="翻转源图重新生成全部" @click="onGenerateFlip" />
        <q-btn flat no-caps icon="refresh" label="重新生成选中" :disable="!selectedIndices.length" @click="onRegenerateSelected" />
        <q-space />
        <q-badge v-if="product" color="blue">
          {{ product.image_process_text }} ({{ product.processing_image_count }} 处理中)
        </q-badge>
      </div>

      <div class="row q-gutter-md">
        <q-card
          v-for="item in imageItems"
          :key="item.index"
          flat
          bordered
          style="width: 280px"
          :class="{ 'bg-blue-1': selectedIndices.includes(item.index) }"
          @click="toggleSelect(item.index)"
        >
          <q-card-section>
            <div class="text-caption text-grey-7">第 {{ item.index + 1 }} 张
              <q-badge :color="statusColor(item.status)" class="q-ml-sm">{{ statusLabel(item.status) }}</q-badge>
            </div>
            <div class="row q-gutter-sm q-mt-sm">
              <div class="col">
                <div class="text-caption">原图</div>
                <q-img :src="originalUrl(item.index)" :ratio="1" fit="contain" style="border: 1px solid #ddd" />
              </div>
              <div class="col">
                <div class="text-caption">生成图</div>
                <q-img v-if="selectedUrl(item)" :src="selectedUrl(item)" :ratio="1" fit="contain" style="border: 1px solid #ddd" />
                <div v-else class="flex flex-center bg-grey-2" style="aspect-ratio: 1">无</div>
              </div>
            </div>
            <div v-if="item.error" class="text-red text-caption q-mt-sm">错误：{{ item.error }}</div>
            <div v-if="item.candidates.length > 1" class="q-mt-sm">
              <div class="text-caption">候选 ({{ item.candidates.length }})</div>
              <div class="row q-gutter-xs">
                <q-img
                  v-for="c in item.candidates"
                  :key="c.path"
                  :src="c.url"
                  :ratio="1"
                  fit="contain"
                  style="width: 56px; height: 56px; border: 1px solid #ddd"
                  @click.stop="onApprove(item.index, c.path)"
                >
                  <q-tooltip>设为选中并审批</q-tooltip>
                </q-img>
              </div>
            </div>
          </q-card-section>
          <q-card-actions align="center">
            <q-btn flat dense color="positive" icon="check" label="通过" @click.stop="onApprove(item.index)" />
            <q-btn flat dense color="warning" icon="close" label="丢弃" @click.stop="onReject(item.index)" />
            <q-btn flat dense icon="refresh" label="重生成" @click.stop="onRegenerateOne(item.index)" />
          </q-card-actions>
        </q-card>
      </div>
    </div>
  </q-page>
</template>

<script setup lang="ts">
import { ref, onMounted, watch, onBeforeUnmount } from "vue";
import { useRoute } from "vue-router";
import { useQuasar } from "quasar";

const $q = useQuasar();
const api = window.gigaApi!;
const route = useRoute();

interface ImageItem {
  index: number;
  original_url: string;
  candidates: { path: string; url: string; created_at: string }[];
  selected_path: string;
  status: string;
  error: string;
}

const productOptions = ref<{ label: string; value: number }[]>([]);
const currentProductId = ref<number | null>(null);
const product = ref<Record<string, unknown> | null>(null);
const imageItems = ref<ImageItem[]>([]);
const selectedIndices = ref<number[]>([]);

onMounted(async () => {
  const pid = route.query.product_id ? Number(route.query.product_id) : null;
  if (pid) {
    currentProductId.value = pid;
    await loadImages();
  }
});

watch(() => route.query.product_id, (v) => {
  if (v) {
    currentProductId.value = Number(v);
    void loadImages();
  }
});

async function loadImages() {
  if (!currentProductId.value) return;
  const r = await api.productsGetImages(currentProductId.value);
  if (r.success) {
    product.value = r.product as Record<string, unknown>;
    const map = r.image_map as { items: ImageItem[] };
    imageItems.value = map.items ?? [];
    startPolling();
  } else {
    $q.notify({ type: "negative", message: r.message ?? "加载失败" });
  }
}

function originalUrl(index: number): string {
  const urls = (product.value?.image_urls as string[]) ?? [];
  return urls[index] ?? "";
}

function selectedUrl(item: ImageItem): string {
  const cand = item.candidates.find((c) => c.path === item.selected_path);
  return cand?.url ?? "";
}

function statusColor(status: string): string {
  switch (status) {
    case "approved": return "green";
    case "generated": return "blue";
    case "processing": return "orange";
    case "failed": return "red";
    case "pending": return "grey";
    default: return "grey";
  }
}
function statusLabel(status: string): string {
  return { approved: "已通过", generated: "已生成", processing: "处理中", failed: "失败", pending: "待处理", rejected: "已丢弃" }[status] ?? status;
}

function toggleSelect(index: number) {
  const i = selectedIndices.value.indexOf(index);
  if (i >= 0) selectedIndices.value.splice(i, 1);
  else selectedIndices.value.push(index);
}

async function onGenerate(flip = false) {
  if (!currentProductId.value) return;
  const r = await api.imagesGenerate({ product_ids: [currentProductId.value], flip_source: flip });
  $q.notify({ type: r.success ? "positive" : "negative", message: r.success ? "任务已创建" : (r.message ?? "失败") });
  if (r.success) await loadImages();
}

function onGenerateFlip() {
  void onGenerate(true);
}

async function onRegenerateSelected() {
  if (!currentProductId.value || !selectedIndices.value.length) return;
  const r = await api.productsRegenerateImages(currentProductId.value, { indices: selectedIndices.value });
  $q.notify({ type: r.success ? "positive" : "negative", message: r.success ? "任务已创建" : (r.message ?? "失败") });
  if (r.success) {
    selectedIndices.value = [];
    await loadImages();
  }
}

async function onRegenerateOne(index: number) {
  if (!currentProductId.value) return;
  const r = await api.productsRegenerateImages(currentProductId.value, { indices: [index] });
  $q.notify({ type: r.success ? "positive" : "negative", message: r.success ? "任务已创建" : (r.message ?? "失败") });
  if (r.success) await loadImages();
}

async function onApprove(index: number, selectedPath?: string) {
  if (!currentProductId.value) return;
  const r = await api.productsApproveImage(currentProductId.value, { index, selected_path: selectedPath });
  $q.notify({ type: r.success ? "positive" : "negative", message: r.success ? "已通过" : (r.message ?? "失败") });
  if (r.success) await loadImages();
}

async function onReject(index: number) {
  if (!currentProductId.value) return;
  const r = await api.productsRejectImage(currentProductId.value, { index });
  $q.notify({ type: r.success ? "positive" : "negative", message: r.success ? "已丢弃" : (r.message ?? "失败") });
  if (r.success) await loadImages();
}

let pollTimer: NodeJS.Timeout | null = null;
function startPolling() {
  stopPolling();
  pollTimer = setInterval(() => {
    if (imageItems.value.some((i) => i.status === "processing")) void loadImages();
  }, 3000);
}
function stopPolling() {
  if (pollTimer) {
    clearInterval(pollTimer);
    pollTimer = null;
  }
}
onBeforeUnmount(stopPolling);
</script>
