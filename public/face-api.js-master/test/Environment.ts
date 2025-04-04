import { NeuralNetwork } from '../src';

export type TestEnv = {
  loadImage: (uri: string) => Promise<HTMLImageElement>
  loadJson: <T> (uri: string) => Promise<T>
  initNet: <TNet extends NeuralNetwork<any>>(
    net: TNet,
    uncompressedFilename?: string | boolean,
    isUnusedModel?: boolean
  ) => any
}
