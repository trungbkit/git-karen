declare module '*.png' {
  const src: string
  export default src
}

declare module '*?raw' {
  const text: string
  export default text
}
