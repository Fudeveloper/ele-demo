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

        <q-toolbar-title> Quasar App </q-toolbar-title>

        <q-btn
          flat
          dense
          no-caps
          icon="system_update"
          label="检查更新"
          :loading="checking"
          @click="onCheckUpdate"
        />

        <div>Quasar v{{ $q.version }}</div>
      </q-toolbar>
    </q-header>

    <q-drawer v-model="leftDrawerOpen" show-if-above bordered>
      <q-list>
        <q-item-label header> 应用导航 </q-item-label>

        <q-item to="/students" clickable v-ripple>
          <q-item-section avatar>
            <q-icon name="school" />
          </q-item-section>
          <q-item-section>
            <q-item-label>学生管理</q-item-label>
            <q-item-label caption>学生信息增删改查</q-item-label>
          </q-item-section>
        </q-item>

        <q-separator spaced />

        <q-item-label header> Essential Links </q-item-label>

        <EssentialLink
          v-for="link in linksList"
          :key="link.label"
          v-bind="link"
        />
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
import EssentialLink, {
  type EssentialLinkProps
} from "@/components/EssentialLink.vue";

const linksList: EssentialLinkProps[] = [
  {
    label: "Docs",
    caption: "quasar.dev",
    icon: "school",
    link: "https://quasar.dev"
  },
  {
    label: "Github",
    caption: "github.com/quasarframework",
    icon: "code",
    link: "https://github.com/quasarframework"
  },
  {
    label: "Discord Chat Channel",
    caption: "chat.quasar.dev",
    icon: "chat",
    link: "https://chat.quasar.dev"
  },
  {
    label: "Forum",
    caption: "forum.quasar.dev",
    icon: "record_voice_over",
    link: "https://forum.quasar.dev"
  },
  {
    label: "Twitter",
    caption: "@quasarframework",
    icon: "rss_feed",
    link: "https://twitter.quasar.dev"
  },
  {
    label: "Facebook",
    caption: "@QuasarFramework",
    icon: "public",
    link: "https://facebook.quasar.dev"
  },
  {
    label: "Quasar Awesome",
    caption: "Community Quasar projects",
    icon: "favorite",
    link: "https://awesome.quasar.dev"
  }
];

const $q = useQuasar();

const leftDrawerOpen = ref(false);

function toggleLeftDrawer() {
  leftDrawerOpen.value = !leftDrawerOpen.value;
}

// ---------- 自动更新 ----------
const checking = ref(false);

async function onCheckUpdate() {
  if (!window.updaterApi) return;
  checking.value = true;
  try {
    const result = await window.updaterApi.check();
    if (result.reason === "dev") {
      $q.notify({
        type: "info",
        message: "开发环境下不检查更新",
        caption: "autoUpdater 仅在打包后生效"
      });
    } else if (result.available) {
      $q.notify({
        type: "positive",
        message: `发现新版本 v${result.version ?? ""}`,
        caption: "正在后台下载，完成后会提示安装"
      });
    } else {
      $q.notify({
        type: "info",
        message: "已是最新版本"
      });
    }
  } catch {
    $q.notify({ type: "negative", message: "检查更新失败" });
  } finally {
    checking.value = false;
  }
}

// 监听「更新已下载」事件，弹窗提示重启安装
const offUpdateDownloaded = window.updaterApi?.onUpdateDownloaded?.((info) => {
  $q.dialog({
    title: "更新已就绪",
    message: `新版本 v${info.version} 已下载完成，是否立即重启安装？`,
    ok: { label: "立即重启", color: "primary", unelevated: true },
    cancel: { label: "稍后", flat: true },
    persistent: true
  }).onOk(() => {
    void window.updaterApi.quitAndInstall();
  });
});

onBeforeUnmount(() => {
  offUpdateDownloaded?.();
});
</script>
