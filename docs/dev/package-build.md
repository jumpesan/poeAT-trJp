# Package Build

This document describes the manual package build procedure for developers who modify poeAT-trJp and want to create a local packaged application.

## Purpose

Use this guide when you need to package the Electron application locally after making changes.

The goal is to make the packaging flow easy to reproduce without relying on GitHub Actions.

## Prerequisites

- Windows development environment
- Node.js and npm
- Repository dependencies can be installed with npm

## Directory Layout

The application is split into two npm projects.

```text
app/renderer
app/main
```

Run the commands below from the repository root unless a step says otherwise.

## 1. Install and build renderer

```powershell
Push-Location .\app\renderer
npm install
npm run build
Pop-Location
```

## 2. Install main process dependencies

```powershell
Push-Location .\app\main
npm install
Pop-Location
```

## 3. Rebuild native dependencies for Electron

`better-sqlite3` is a native dependency and must be rebuilt for the Electron runtime used by this project.

```powershell
Push-Location .\app\main
npm rebuild better-sqlite3 --runtime=electron --target=40.9.1 --disturl=https://electronjs.org/headers
Pop-Location
```

If the Electron version changes, update the `--target` value to match the Electron version used by `app/main/package.json`.

## 4. Build main process

```powershell
Push-Location .\app\main
npm run build
Pop-Location
```

## 5. Package the application

```powershell
Push-Location .\app\main
npm run package
Pop-Location
```

## Verification

After packaging completes, confirm the following manually:

- The package command completed without errors
- The packaged application starts correctly
- Basic screens can be opened
  - Price check
  - Settings
  - About

## Notes

This project currently uses local package verification instead of a required GitHub Actions status check.
