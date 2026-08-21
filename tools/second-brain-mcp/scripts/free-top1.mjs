#!/usr/bin/env bun
/**
 * Печатает id топ-1 БЕСПЛАТНОЙ модели OpenRouter (или ничего, если каталог
 * недоступен). Вызывается docker/entrypoint.sh, чтобы cheap-тир
 * smart_model_routing по умолчанию был бесплатным, а не «дешёвым платным».
 *
 * Молчаливый выход 1 при неудаче — вызывающий обязан иметь фолбэк.
 * Использование: bun run scripts/free-top1.mjs [--modalities image,text]
 */
import { freeTop1 } from "../src/lib/freeCatalog.js";

const arg = process.argv.indexOf("--modalities");
const modalities = arg === -1 ? [] : (process.argv[arg + 1] || "").split(",").filter(Boolean);

const id = await freeTop1({ modalities });
if (!id) process.exit(1);
console.log(id);
