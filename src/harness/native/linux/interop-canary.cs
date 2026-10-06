// Harmless WSL interop probe. No arguments, environment, files, registry or network are read.
using System;
internal static class InteropCanary {
  private static int Main() { Console.Write("aih-native-interop-reached"); return 42; }
}
