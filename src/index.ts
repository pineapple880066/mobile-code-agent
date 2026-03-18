#!/usr/bin/env node

// CLI 入口文件
// 负责加载环境变量、构建 CLI 程序并解析命令行参数
// 使用 dotenv 加载 .env 文件中的环境变量

import { config as loadEnv } from "dotenv";

import { buildProgram, normalizeArgv } from "./cli.js";

loadEnv();

const program = buildProgram();
await program.parseAsync(normalizeArgv(process.argv));
