declare module 'earcut' {
  export default function earcut(
    vertices: ArrayLike<number>,
    holes?: ArrayLike<number> | null,
    dimensions?: number,
  ): number[];
}
