import type { RouteRecordRaw } from "vue-router";

const routes: RouteRecordRaw[] = [
  {
    path: "/",
    component: () => import("@/layouts/MainLayout.vue"),
    redirect: "/accounts",
    children: [
      { path: "accounts", component: () => import("@/pages/AccountsPage.vue") },
      { path: "products", component: () => import("@/pages/ProductsPage.vue") },
      { path: "upload", component: () => import("@/pages/UploadPage.vue") },
      { path: "images", component: () => import("@/pages/ImagesPage.vue") },
      { path: "jobs", component: () => import("@/pages/JobsPage.vue") },
    ],
  },
  {
    path: "/:catchAll(.*)*",
    component: () => import("@/pages/ErrorNotFound.vue"),
  },
];

export default routes;
