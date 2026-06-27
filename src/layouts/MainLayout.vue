<template>
  <q-layout view="lHh Lpr lFf">
    <q-header elevated>
      <q-toolbar>
        <q-btn
          flat
          dense
          round
          icon="menu"
          aria-label="Menu"
          @click="toggleLeftDrawer"
        />

        <q-toolbar-title> GIGA B2B 工具台 </q-toolbar-title>

        <q-btn
          flat
          dense
          no-caps
          icon="system_update"
          label="检查更新"
          :loading="checking"
          @click="onCheckUpdate"
        />
      </q-toolbar>
    </q-header>

    <q-drawer v-model="leftDrawerOpen" show-if-above bordered>
      <q-list>
        <q-item-label header> 应用导航 </q-item-label>

        <q-item
          v-for="item in navItems"
          :key="item.path"
          :to="item.path"
          clickable
          v-ripple
          exact
        >
          <q-item-section avatar>
            <q-icon :name="item.icon" />
          </q-item-section>
          <q-item-section>
            <q-item-label>{{ item.label }}</q-item-label>
            <q-item-label caption>{{ item.caption }}</q-item-label>
          </q-item-section>
        </q-item>

        <q-separator spaced />

        <q-item clickable v-ripple @click="onOpenStudio">
          <q-item-section avatar>
            <q-icon name="auto_awesome" />
          </q-item-section>
          <q-item-section>
            <q-item-label>精品编辑工作台</q-item-label>
            <q-item-label caption>Amazon Image Studio</q-item-label>
          </q-item-section>
        </q-item>
      </q-list>
    </q-drawer>

    <q-page-container>
      <router-view />
    </q-page-container>
  </q-layout>
</template>

<script setup lang="ts">
import { onBeforeUnmount, ref } from "vue";
import { useQuasar } from "quasar";

const $q = useQuasar();

const navItems = [
  { path: "/accounts", icon: "manage_accounts", label: "账号管理", caption: "GIGA 账号增删改查" },
  { path: "/products", icon: "inventory_2", label: "商品列表", caption: "商品同步与处理" },
  { path: "/upload", icon: "upload_file", label: "本地上传", caption: "本地图片合成商品" },
  { path: "/images", icon: "image", label: "图片处理", caption: "生成图审阅工作台" },
  { path: "/jobs", icon: "history", label: "任务记录", caption: "后台任务日志" },
];

const leftDrawerOpen = ref(false);

function toggleLeftDrawer() {
  leftDrawerOpen.value = !leftDrawerOpen.value;
}

async function onOpenStudio() {
  if (!window.gigaApi) return;
  const r = await window.gigaApi.openStudio();
  if (!r.success) $q.notify({ type: "negative", message: r.message ?? "打开失败" });
}

// ---------- 自动更新 ----------
const checking = ref(false);

async function onCheckUpdate() {
  if (!window.updaterApi) return;
  checking.value = true;
  try {
    const result = await window.updaterApi.check();
    if (result.reason === "dev") {
      $q.notify({ type: "info", message: "开发环境下不检查更新", caption: "autoUpdater 仅在打包后生效" });
    } else if (result.available) {
      $q.notify({ type: "positive", message: `发现新版本 v${result.version ?? ""}`, caption: "正在后台下载，完成后会提示安装" });
    } else {
      $q.notify({ type: "info", message: "已是最新版本" });
    }
  } catch {
    $q.notify({ type: "negative", message: "检查更新失败" });
  } finally {
    checking.value = false;
  }
}

const offUpdateDownloaded = window.updaterApi?.onUpdateDownloaded?.((info) => {
  $q.dialog({
    title: "更新已就绪",
    message: `新版本 v${info.version} 已下载完成，是否立即重启安装？`,
    ok: { label: "立即重启", color: "primary", unelevated: true },
    cancel: { label: "稍后", flat: true },
    persistent: true,
  }).onOk(() => {
    void window.updaterApi?.quitAndInstall();
  });
});

onBeforeUnmount(() => {
  offUpdateDownloaded?.();
});
</script>
