# Awakened PoE Trade JP - current app dependency diagram

作成対象: `main-src.zip` と `app-renderer.zip` の `src` 配下。
`package.json` は今回の zip には含まれていないため、npm パッケージ依存は import から見える範囲の推定です。

## 1. 全体構成

```mermaid
flowchart LR
  User[User / PoE Client] --> Electron[Electron App]

  subgraph Main[main process]
    MainEntry[src/main.ts]
    Server[src/server.ts\nHTTP + WebSocket /events]
    ConfigStore[host-files/ConfigStore.ts]
    GameConfig[host-files/GameConfig.ts]
    GameLogWatcher[host-files/GameLogWatcher.ts]
    PoeLogin[host-files/PoeLogin.ts\npersist:poe-login]
    Shortcuts[shortcuts/Shortcuts.ts]
    OverlayWindow[windowing/OverlayWindow.ts]
    GameWindow[windowing/GameWindow.ts]
    OverlayVisibility[windowing/OverlayVisibility.ts]
    Proxy[src/proxy.ts]
    AppUpdater[src/AppUpdater.ts]
    AppTray[src/AppTray.ts]
    Logger[src/RemoteLogger.ts]
  end

  subgraph Renderer[renderer process / web app]
    RendererEntry[src/main.ts]
    WebApp[web/App.vue]
    IPC[web/background/IPC.ts\nHostTransport]
    Config[web/Config.ts]
    Settings[web/settings/SettingsWindow.vue]
    StashCheck[web/settings/stash-check.vue]
    Overlay[web/overlay/*]
    PriceCheck[web/price-check/*]
    ItemCheck[web/item-check/*]
    ItemSearch[web/item-search/*]
    MapCheck[web/map-check/*]
    StashSearch[web/stash-search/*]
    Parser[parser/*]
    Assets[assets/data/*]
  end

  MainEntry --> Server
  MainEntry --> Logger
  MainEntry --> GameLogWatcher
  MainEntry --> GameConfig
  MainEntry --> PoeLogin
  MainEntry --> OverlayWindow
  MainEntry --> OverlayVisibility
  MainEntry --> Shortcuts
  MainEntry --> AppUpdater
  MainEntry --> AppTray
  MainEntry --> Proxy

  Server --> ConfigStore
  Server --> RendererEntry
  RendererEntry --> WebApp
  WebApp --> IPC
  Config --> IPC

  PriceCheck --> Parser
  ItemCheck --> Parser
  ItemSearch --> Parser
  MapCheck --> Parser
  Parser --> Assets

  Settings --> StashCheck
  StashCheck --> IPC
  Overlay --> IPC
  PriceCheck --> IPC
  ItemCheck --> IPC
  ItemSearch --> IPC
  StashSearch --> IPC
```

## 2. main process の依存関係

```mermaid
flowchart TD
  main_ts[src/main.ts]
  server[src/server.ts]
  RemoteLogger[src/RemoteLogger.ts]
  AppTray[src/AppTray.ts]
  AppUpdater[src/AppUpdater.ts]
  HttpProxy[src/proxy.ts]

  subgraph HostFiles[host-files]
    ConfigStore[ConfigStore.ts]
    GameConfig[GameConfig.ts]
    GameLogWatcher[GameLogWatcher.ts]
    PoeLogin[PoeLogin.ts]
    FileUploads[file-uploads.ts]
  end

  subgraph Windowing[windowing]
    GameWindow[GameWindow.ts]
    OverlayWindow[OverlayWindow.ts]
    OverlayVisibility[OverlayVisibility.ts]
    WidgetAreaTracker[WidgetAreaTracker.ts]
  end

  subgraph Shortcuts[shortcuts]
    ShortcutsTs[Shortcuts.ts]
    HostClipboard[HostClipboard.ts]
    TextBox[text-box.ts]
  end

  subgraph Vision[vision]
    HeistGemFinder[HeistGemFinder.ts]
    VisionLinkMain[link-main.ts]
    VisionWorker[link-worker.ts]
  end

  main_ts --> server
  main_ts --> RemoteLogger
  main_ts --> AppTray
  main_ts --> AppUpdater
  main_ts --> HttpProxy
  main_ts --> GameConfig
  main_ts --> GameLogWatcher
  main_ts --> PoeLogin
  main_ts --> GameWindow
  main_ts --> OverlayWindow
  main_ts --> OverlayVisibility
  main_ts --> ShortcutsTs

  server --> ConfigStore
  server --> FileUploads
  GameLogWatcher --> RemoteLogger
  GameConfig --> RemoteLogger
  OverlayWindow --> GameWindow
  OverlayVisibility --> OverlayWindow
  OverlayVisibility --> GameConfig
  ShortcutsTs --> HostClipboard
  ShortcutsTs --> GameWindow
  ShortcutsTs --> OverlayWindow
  ShortcutsTs --> GameConfig
  ShortcutsTs --> HeistGemFinder
```

## 3. renderer process の依存関係

```mermaid
flowchart TD
  renderer_main[src/main.ts]
  AppVue[web/App.vue]
  IPC[web/background/IPC.ts]
  Config[web/Config.ts]
  I18n[web/i18n.ts]

  subgraph Settings[settings]
    SettingsWindow[SettingsWindow.vue]
    StashCheck[stash-check.vue]
    General[general.vue]
    Hotkeys[hotkeys.vue]
    Debug[debug.vue]
  end

  subgraph Overlay[overlay]
    OverlayWindow[OverlayWindow.vue]
    WidgetRegistry[widget-registry.js]
    Widgets[Widget*.vue]
  end

  subgraph Features[feature widgets]
    PriceCheck[price-check/*]
    ItemCheck[item-check/*]
    ItemSearch[item-search/*]
    MapCheck[map-check/*]
    StashSearch[stash-search/*]
    Stopwatch[stopwatch/*]
  end

  subgraph Parser[parser]
    ParserTs[Parser.ts]
    ParsedItem[ParsedItem.ts]
    Modifiers[modifiers.ts]
    StatTranslations[stat-translations.ts]
  end

  subgraph Assets[assets/data]
    DataIndex[index.ts]
    Interfaces[interfaces.ts]
  end

  renderer_main --> AppVue
  renderer_main --> Config
  renderer_main --> IPC
  AppVue --> OverlayWindow
  Config --> IPC
  Config --> WidgetRegistry
  SettingsWindow --> Config
  SettingsWindow --> IPC
  SettingsWindow --> StashCheck
  StashCheck --> IPC

  OverlayWindow --> IPC
  OverlayWindow --> Config
  Overlay --> Features

  PriceCheck --> ParserTs
  ItemCheck --> ParserTs
  ItemSearch --> ParserTs
  MapCheck --> ParserTs
  ParserTs --> StatTranslations
  ParserTs --> Modifiers
  ParserTs --> ParsedItem
  Parser --> DataIndex
```

## 4. IPC / WebSocket イベント関係

```mermaid
sequenceDiagram
  participant R as Renderer HostTransport\nweb/background/IPC.ts
  participant S as Main server.ts\nWebSocket /events
  participant M as Main modules
  participant P as Path of Exile Web

  R->>S: CLIENT->MAIN::save-config
  S->>M: ConfigStore.save()
  M-->>R: MAIN->CLIENT::config-changed

  R->>S: CLIENT->MAIN::update-host-config
  S->>M: overlay / shortcuts / GameLogWatcher / GameConfig update

  R->>S: CLIENT->MAIN::user-action
  S->>M: AppTray / AppUpdater / Shortcuts actions

  R->>S: CLIENT->MAIN::poe-login-open
  S->>M: PoeLogin.openLoginWindow()
  M->>P: BrowserWindow login page
  P-->>M: POESESSID cookie in persist:poe-login

  R->>S: CLIENT->MAIN::poe-login-status
  S->>M: PoeLogin.isLoggedIn()
  M-->>R: MAIN->CLIENT::poe-login-status

  R->>S: CLIENT->MAIN::poe-get-characters
  S->>M: PoeLogin.getCharacters()
  M->>P: /character-window/get-characters
  P-->>M: characters JSON
  M-->>R: MAIN->CLIENT::poe-characters
```

## 5. 現在の stash/snapshot 周り

```mermaid
flowchart LR
  StashCheck[renderer\nsettings/stash-check.vue]
  Host[renderer\nweb/background/IPC.ts]
  Server[main\nserver.ts eventPipe]
  PoeLogin[main\nhost-files/PoeLogin.ts]
  PoeWeb[pathofexile.com]
  Config[renderer\nweb/Config.ts\nstashCheck.selectedCharacter]

  StashCheck -->|CLIENT->MAIN::poe-login-open| Host
  Host --> Server
  Server --> PoeLogin
  PoeLogin -->|BrowserWindow /login| PoeWeb

  StashCheck -->|CLIENT->MAIN::poe-login-status| Host
  PoeLogin -->|MAIN->CLIENT::poe-login-status| StashCheck

  StashCheck -->|CLIENT->MAIN::poe-get-characters| Host
  PoeLogin -->|/character-window/get-characters| PoeWeb
  PoeLogin -->|MAIN->CLIENT::poe-characters| StashCheck

  StashCheck -->|決定| Config

  Missing[未実装\ncharacter inventory raw snapshot取得]
  Config -.selectedCharacter.-> Missing
  PoeLogin -.POESESSID / cf_clearance.-> Missing
```

## 6. 外部依存の見える範囲

### main 側

- electron
- ws
- http / fs / path / events / net / crypto / node:os
- uiohook-napi
- electron-overlay-window
- electron-updater
- comlink / worker_threads
- ini
- @wokwi/bmp-ts

### renderer 側

- vue
- vue-i18n
- @vueuse/core
- sockette
- luxon
- tippy.js
- neverthrow
- fast-deep-equal
- fastest-levenshtein
- object-hash
- dot-prop
- vuedraggable
- vue3-apexcharts

## 7. 次に snapshot 実装で追加される想定依存

```mermaid
flowchart LR
  StashCheck[settings/stash-check.vue]
  Config[Config.ts\naccountName / realm / selectedCharacter]
  PoeLogin[PoeLogin.ts]
  SnapshotStore[新規候補\nhost-files/SnapshotStore.ts]
  PoeWeb[PoE Web API\n/character-window/get-items]
  RawFile[userData or app cache\nraw snapshot JSON]

  StashCheck -->|CLIENT->MAIN::poe-get-character-items| PoeLogin
  Config -->|character / realm / accountName| StashCheck
  PoeLogin -->|session.fetch with cookies| PoeWeb
  PoeLogin --> SnapshotStore
  SnapshotStore --> RawFile
  PoeLogin -->|MAIN->CLIENT::poe-character-items-saved| StashCheck
```
