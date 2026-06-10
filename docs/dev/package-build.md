# Package Build

This document describes the local package build procedure for developers.

## Purpose

Use this procedure to create a local packaged build of poeAT-trJp.

The package build is mainly used before release-related changes are merged or published.

## Command

Run the packaging script from the repository root.

```powershell
.\tools\package_build_simple.ps1
```

## What the script does

The script performs the local build and packaging flow for the Electron application.

Main steps:

- Build renderer
- Build main process
- Rebuild native dependencies when needed
- Package the Electron application

## Verification

After the script finishes, confirm the following manually:

- The script completed without errors
- The packaged application starts correctly
- Basic screens can be opened
  - Price check
  - Settings
  - About

This project currently uses local package verification instead of a required GitHub Actions status check.
