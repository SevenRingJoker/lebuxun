/// <reference types="vite/client" />

// 声明 Vite ?worker 导入，供 Monaco Editor worker 使用
declare module '*?worker' {
  const workerConstructor: new () => Worker
  export default workerConstructor
}
