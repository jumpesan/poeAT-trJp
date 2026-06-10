# Package Build

This document describes the manual package build procedure for developers who modify poeAT-trJp and want to create a local packaged application.

## Platform

This project is currently developed and packaged for Windows.

The commands below are intended for Windows environments. They can be run from Command Prompt or PowerShell.

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

Run the commands below from the repository root.

## 1. Install and build renderer

```cmd
cd app\renderer
npm install
npm run build
cd ..\..
```

## 2. Install main process dependencies

```cmd
cd app\main
npm install
cd ..\..
```

## 3. Rebuild native dependencies for Electron

`better-sqlite3` is a native dependency and must be rebuilt for the Electron runtime used by this project.

```cmd
cd app\main
npm rebuild better-sqlite3 --runtime=electron --target=40.9.1 --disturl=https://electronjs.org/headers
cd ..\..
```

If the Electron version changes, update the `--target` value to match the Electron version used by `app/main/package.json`.

## 4. Build main process

```cmd
cd app\main
npm run build
cd ..\..
```

## 5. Package the application

```cmd
cd app\main
npm run package
cd ..\..
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
