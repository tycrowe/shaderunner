import { defineConfig } from "vite";
import sassDts from "vite-plugin-sass-dts";

export default defineConfig({
    plugins: [sassDts()]
});