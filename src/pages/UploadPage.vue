<template>
  <q-page padding>
    <div class="text-h6 q-mb-md">本地上传</div>
    <q-card flat bordered style="max-width: 640px">
      <q-card-section class="q-gutter-md">
        <q-select v-model="form.account_id" :options="accountOptions" label="选择账号 *" outlined emit-value map-options />
        <q-input v-model="form.item_code" label="货号 (itemCode)" outlined hint="留空将自动生成" />
        <q-input v-model="form.product_name" label="商品名称" outlined />
        <q-file
          v-model="files"
          label="选择图片 *"
          outlined
          multiple
          accept=".jpg,.jpeg,.png,.webp"
          hint="支持 jpg/jpeg/png/webp"
        >
          <template #prepend>
            <q-icon name="attach_file" />
          </template>
        </q-file>
      </q-card-section>
      <q-card-actions align="right">
        <q-btn unelevated color="primary" label="上传并创建" @click="onUpload" :disable="!form.account_id || !files.length" />
      </q-card-actions>
    </q-card>
  </q-page>
</template>

<script setup lang="ts">
import { ref, onMounted } from "vue";
import { useQuasar } from "quasar";

const $q = useQuasar();
const api = window.gigaApi!;

const accountOptions = ref<{ label: string; value: number }[]>([]);
const form = ref({ account_id: null as number | null, item_code: "", product_name: "" });
const files = ref<File[]>([]);

onMounted(async () => {
  const r = await api.accountsList();
  if (r.success) {
    accountOptions.value = (r.items as Array<Record<string, unknown>>)
      .filter((a) => a.enabled)
      .map((a) => ({ label: String(a.account_name), value: Number(a.id) }));
  }
});

async function onUpload() {
  if (!form.value.account_id || !files.value.length) return;
  $q.loading.show({ message: "上传中..." });
  try {
    const filePayload = await Promise.all(
      files.value.map(async (f) => ({ name: f.name, data: await f.arrayBuffer() })),
    );
    const r = await api.productsUploadLocalImages({
      account_id: form.value.account_id,
      item_code: form.value.item_code,
      product_name: form.value.product_name,
      files: filePayload,
    });
    if (r.success) {
      $q.notify({ type: "positive", message: "创建成功" });
      const product = r.product as { id: number };
      const { useRouter } = await import("vue-router");
      void useRouter().push({ path: "/images", query: { product_id: String(product.id) } });
    } else {
      $q.notify({ type: "negative", message: r.message ?? "上传失败" });
    }
  } finally {
    $q.loading.hide();
  }
}
</script>
