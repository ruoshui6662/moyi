/**
 * chrome.runtime 最小子集 shim：把扩展中跨进程的消息总线本地化为同一闭包内的直连调用。
 *
 * 第一性原理：油猴脚本 = content script 与 background 合体。扩展里 content ⇄ background
 * 的 sendMessage / connect Port，在这里退化为注册表查找 + 函数调用，语义保持一致：
 *   - sendMessage(message) → 依序匹配 onMessage 监听器，监听器返回 true 表示异步应答；
 *   - connect({name}) → 返回最小 Port（postMessage/onMessage/onDisconnect/disconnect），
 *     「background」侧在 onConnect 回调里持有同一 Port 对象收发事件。
 *
 * 页面脚本无法触及本闭包内的注册表——消息只能由脚本自身发起，无伪造面。
 */

type ResponseCallback = (response: unknown) => void;
export type OnMessageListener = (
  message: unknown,
  sender: unknown,
  sendResponse: ResponseCallback,
) => boolean | void;

interface BusPort {
  name: string;
  postMessage: (message: unknown) => void;
  disconnect: () => void;
  onMessage: { addListener: (listener: (message: unknown) => void) => void };
  onDisconnect: { addListener: (listener: () => void) => void };
}

const messageListeners = new Set<OnMessageListener>();
const portListeners = new Set<(port: BusPort) => void>();

/** 发送消息：找到第一个返回 true 的监听器并等待其异步应答；无人应答则返回 undefined。 */
const sendMessage = async (message: unknown): Promise<unknown> =>
  new Promise((resolve) => {
    const sendResponse = (response: unknown): void => resolve(response);
    for (const listener of [...messageListeners]) {
      let responded = false;
      const wrapped = (response: unknown): void => {
        if (responded) return;
        responded = true;
        sendResponse(response);
      };
      const wantsAsync = listener(message, { id: 'local' }, wrapped);
      // 同步路径：监听器未声明异步应答时视为同步完成（可能已同步调用 sendResponse）
      if (!wantsAsync && !responded) {
        // 继续尝试下一个监听器（与扩展语义一致：无 true 则最终无应答）
        continue;
      }
      if (responded || wantsAsync) return;
    }
    resolve(undefined);
  });

export const installBusShim = (): void => {
  const holder = window as Omit<typeof window, 'chrome'> & { chrome?: Record<string, unknown> };
  holder.chrome ??= {};
  const chrome = holder.chrome as Record<string, unknown>;

  chrome.runtime = {
    sendMessage: (message: unknown): Promise<unknown> => sendMessage(message),
    onMessage: {
      addListener: (listener: OnMessageListener): void => {
        messageListeners.add(listener);
      },
      removeListener: (listener: OnMessageListener): void => {
        messageListeners.delete(listener);
      },
    },
    onConnect: {
      addListener: (listener: (port: BusPort) => void): void => {
        portListeners.add(listener);
      },
    },
    connect: (details: { name?: string }): BusPort => {
      const name = details?.name ?? '';
      const clientSide: {
        name: string;
        postMessage: (message: unknown) => void;
        disconnect: () => void;
        onMessage: { addListener: (l: (m: unknown) => void) => void; removeListener?: (l: (m: unknown) => void) => void };
        onDisconnect: { addListener: (l: () => void) => void };
      } = {
        name,
        postMessage: (): void => {},
        disconnect: (): void => {},
        onMessage: { addListener: (): void => {} },
        onDisconnect: { addListener: (): void => {} },
      };

      const serverSide: {
        name: string;
        postMessage: (message: unknown) => void;
        disconnect: () => void;
        onMessage: { addListener: (l: (m: unknown) => void) => void };
        onDisconnect: { addListener: (l: () => void) => void };
      } = {
        name,
        postMessage: (): void => {},
        disconnect: (): void => {},
        onMessage: { addListener: (): void => {} },
        onDisconnect: { addListener: (): void => {} },
      };

      const clientMessageListeners = new Set<(m: unknown) => void>();
      const serverMessageListeners = new Set<(m: unknown) => void>();
      const clientDisconnectListeners = new Set<() => void>();
      const serverDisconnectListeners = new Set<() => void>();

      clientSide.postMessage = (message: unknown): void => {
        for (const l of [...serverMessageListeners]) l(message);
      };
      serverSide.postMessage = (message: unknown): void => {
        for (const l of [...clientMessageListeners]) l(message);
      };
      const closeClient = (): void => {
        for (const l of [...clientDisconnectListeners]) l();
      };
      const closeServer = (): void => {
        for (const l of [...serverDisconnectListeners]) l();
      };
      clientSide.disconnect = (): void => {
        closeServer();
      };
      serverSide.disconnect = (): void => {
        closeClient();
      };
      clientSide.onMessage.addListener = (l: (m: unknown) => void): void => {
        clientMessageListeners.add(l);
      };
      serverSide.onMessage.addListener = (l: (m: unknown) => void): void => {
        serverMessageListeners.add(l);
      };
      clientSide.onDisconnect.addListener = (l: () => void): void => {
        clientDisconnectListeners.add(l);
      };
      serverSide.onDisconnect.addListener = (l: () => void): void => {
        serverDisconnectListeners.add(l);
      };

      // 通知「background」侧：客户端 → 服务端方向建立端口
      for (const listener of [...portListeners]) {
        try {
          listener(serverSide as BusPort & { name: string });
        } catch {
          // 单个监听器异常不影响其他监听器
        }
      }

      return clientSide as BusPort;
    },
  };
};
