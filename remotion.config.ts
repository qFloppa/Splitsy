import { Config } from "@remotion/cli/config";

// The repo's public/ is Next's, and Remotion reads staticFile() from the same
// place — so the Clash woff2 and the logos are already where both want them.
Config.setPublicDir("public");

// Typography on a large flat-colour ground is exactly what h264 bands and
// smears. CRF 16 is visually lossless here and the file is still small enough
// for X's upload limit at 18 seconds.
Config.setCodec("h264");
Config.setCrf(16);
Config.setPixelFormat("yuv420p");
