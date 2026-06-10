export {}

type IpcInvoke = (channel: string, ...args: unknown[]) => Promise<unknown>

declare global {
  interface Window {
    electron: {
      ipcRenderer: {
        invoke: IpcInvoke
      }
    }
  }
}