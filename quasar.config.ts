// Configuration for your app
// https://v2.quasar.dev/quasar-cli-vite/quasar-config-file

import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { defineConfig } from "#q-app";

/**
 * 读取 src-electron 中已安装的 electron 版本，避免 electron-builder 在
 * --prod 安装后的 UnPackaged 目录里找不到 electron 模块而报错。
 *
 * 注意：该函数在 `quasar prepare`（root postinstall）阶段也会被调用，
 * 此时 src-electron 的 node_modules 可能尚未安装，因此用 try/catch 兜底，
 * 读不到时返回 undefined（prepare 不打包，无影响）；真正 `quasar build`
 * 时 src-electron 已安装，能正确读到版本号。
 */
function readElectronVersion(): string | undefined {
  try {
    const pkg = JSON.parse(
      readFileSync(
        resolve(process.cwd(), "src-electron/node_modules/electron/package.json"),
        "utf8"
      )
    ) as { version?: string };
    return pkg.version;
  } catch {
    return undefined;
  }
}

export default defineConfig((/* ctx */) => {
  return {
    // https://v2.quasar.dev/quasar-cli-vite/prefetch-feature
    // preFetch: true,

    // app boot file (/src/boot)
    // --> boot files are part of "main.js"
    // https://v2.quasar.dev/quasar-cli-vite/boot-files
    boot: [],

    // https://v2.quasar.dev/quasar-cli-vite/quasar-config-file#css
    css: ["app.scss"],

    // https://github.com/quasarframework/quasar/tree/dev/extras
    extras: [
      // 'ionicons-v4',
      // 'mdi-v7',
      // 'fontawesome-v7',
      // 'eva-icons',
      // 'themify',
      // 'line-awesome',
      // 'roboto-font-latin-ext', // this or either 'roboto-font', NEVER both!

      "roboto-font", // optional, you are not bound to it
      "material-icons" // optional, you are not bound to it
    ],

    // https://v2.quasar.dev/quasar-cli-vite/quasar-config-file#build
    build: {
      target: {
        // browser: 'baseline-widely-available',
        // node: 'node22'
      },

      typescript: {
        strict: true,
        vueShim: true
        // extendTsConfig (tsConfig) {}
      },

      // https://v2.quasar.dev/quasar-cli-vite/page-routing-with-vue-router#filename-based-routing
      // filenameBasedRouting: true,

      vueRouterMode: "hash" // available values: 'hash', 'history'
      // vueRouterBase,
      // vueDevtools,

      // publicPath: '/',
      // define: {},
      // defineEnv: {}
      // ignorePublicFolder: true,
      // minify: false,
      // distDir

      // extendViteConf (viteConf) {},
      // viteVuePluginOptions: {},

      // vitePlugins: [
      //   [ 'package-name', { ..pluginOptions.. }, { server: true, client: true } ]
      // ]
    },

    // https://v2.quasar.dev/quasar-cli-vite/quasar-config-file#devserver
    devServer: {
      // https: true,
      open: true // opens browser window automatically
    },

    // https://v2.quasar.dev/quasar-cli-vite/quasar-config-file#framework
    framework: {
      config: {},

      // iconSet: 'material-icons', // Quasar icon set
      // lang: 'en-US', // Quasar language pack

      // For special cases outside of where the auto-import strategy can have an impact
      // (like functional components as one of the examples),
      // you can manually specify Quasar components/directives to be available everywhere:
      //
      // components: [],
      // directives: [],

      // Quasar plugins
      plugins: ["Notify", "Dialog"]
    },

    // animations: 'all', // --- includes all animations
    // https://v2.quasar.dev/options/animations
    animations: [],

    // https://v2.quasar.dev/quasar-cli-vite/quasar-config-file#sourcefiles
    // sourceFiles: {
    //   rootComponent: 'src/App.vue',
    //   router: 'src/router/index',
    //   store: 'src/store/index',
    //   pwaRegisterServiceWorker: 'src-pwa/register-sw',
    //   pwaServiceWorker: 'src-pwa/sw/custom-sw',
    //   pwaManifestFile: 'src-pwa/manifest.json',
    //   electronMain: 'src-electron/electron-main',
    //   electronPreload: 'src-electron/electron-preload'
    //   bexManifestFile: 'src-bex/manifest.json
    // },

    // https://v2.quasar.dev/quasar-cli-vite/developing-ssr/configuring-ssr
    ssr: {
      prodPort: 3000, // The default port that the production server should use
      // (gets superseded if process.env.PORT is specified at runtime)

      middlewares: [
        "render" // keep this as last one
      ],

      // extendSSRPackageJson (pkgJson) {},
      // extendSSRWebserverConf (rolldownConf) {},

      // manualStoreSerialization: true,
      // manualStoreSsrContextInjection: true,
      // manualStoreHydration: true,
      // manualPostHydrationTrigger: true,

      pwa: false
      // pwaOfflineHtmlFilename: 'offline.html', // do NOT use index.html as name!

      // extendSSRGenerateSWOptions (cfg) {},
      // extendSSRInjectManifestOptions (cfg) {}
    },

    // https://v2.quasar.dev/quasar-cli-vite/developing-pwa/configuring-pwa
    pwa: {
      workboxMode: "GenerateSW" // 'GenerateSW' or 'InjectManifest'
      // swFilename: 'sw.js',
      // manifestFilename: 'manifest.json',
      // extendPWAManifestJson (json) {},
      // useCredentialsForManifestTag: true,
      // injectPWAMetaTags: false,
      // extendPWACustomSWConf (rolldownConf) {},
      // extendPWAGenerateSWOptions (cfg) {},
      // extendPWAInjectManifestOptions (cfg) {},
      // extendPWASwTsConfig (tsConfig) {}
    },

    // https://v2.quasar.dev/quasar-cli-vite/developing-cordova-apps/configuring-cordova
    cordova: {},

    // https://v2.quasar.dev/quasar-cli-vite/developing-capacitor-apps/configuring-capacitor
    capacitor: {
      hideSplashscreen: true
    },

    // https://v2.quasar.dev/quasar-cli-vite/developing-electron-apps/configuring-electron
    electron: {
      extendElectronMainConf(rolldownConf) {
        // 根 package.json 是 "type": "module"，.js 被当作 ESM。
        // 但 Quasar 打包后的代码中部分依赖使用了 __dirname（CJS 全局变量）。
        // 通过 intro 注入 polyfill，用 import.meta.dirname 替代。
        const out = rolldownConf.output;
        if (out && typeof out === 'object' && !Array.isArray(out)) {
          out.intro = 'const __dirname = import.meta.dirname;\n' + (out.intro ?? '');
        }
      },
      // extendElectronPackageJson (pkgJson) {},

      // Electron preload scripts (if any) from /src-electron, WITHOUT file extension
      preloadScripts: ["electron-preload"],

      // specify the debugging port to use for the Electron app when running in development mode
      inspectPort: 5858,

      bundler: "builder", // 'packager' or 'builder'

      packager: {
        // https://github.com/electron-userland/electron-packager/blob/master/docs/api.md#options
        // OS X / Mac App Store
        // appBundleId: '',
        // appCategoryType: '',
        // osxSign: '',
        // protocol: 'myapp://path',
        // Windows only
        // win32metadata: { ... }
      },

      builder: {
        // https://www.electron.build/configuration
        appId: "com.gigab2b.tool",
        productName: "GIGA B2B 工具台",

        // 显式指定 Electron 版本，避免 electron-builder 在打包后的
        // UnPackaged 目录中找不到 electron 模块而无法推断版本。
        ...(readElectronVersion()
          ? { electronVersion: readElectronVersion() }
          : {}),

        // 额外资源：Amazon Image Studio 静态文件，放到 resources/studio
        extraResources: [
          {
            from: "src-electron/assets/studio",
            to: "studio",
            filter: ["**/*"],
          },
        ],

        // 原生模块解包（better-sqlite3 / sharp 不能在 asar 内加载）
        asarUnpack: [
          "**/node_modules/better-sqlite3/**",
          "**/node_modules/sharp/**",
          "**/node_modules/@img/**",
        ],

        // 自动更新发布源 —— 通过环境变量 GH_OWNER / GH_REPO 配置，
        // 默认占位符需替换为真实仓库。环境变量优先级更高（方便 CI 覆盖）。
        publish: {
          provider: "github",
          owner: process.env.GH_OWNER || "<YOUR_GH_OWNER>",
          repo: process.env.GH_REPO || "quasar-demo"
        },

        win: {
          target: ["nsis"]
        },

        nsis: {
          oneClick: false,
          allowToChangeInstallationDirectory: true,
          perMachine: false
        }
      }
    },

    // https://v2.quasar.dev/quasar-cli-vite/developing-browser-extensions/configuring-bex
    bex: {
      // extendBexScriptsConf (rolldownConf) {},
      // extendBexManifestJson (json) {},

      /**
       * The list of extra scripts (js/ts) not in your bex manifest that you want to
       * compile and use in your browser extension. Maybe dynamic use them?
       *
       * Each entry in the list should be a relative filename to /src-bex/
       *
       * @example [ 'my-script.ts', 'sub-folder/my-other-script.js' ]
       */
      extraScripts: []
    }
  };
});
