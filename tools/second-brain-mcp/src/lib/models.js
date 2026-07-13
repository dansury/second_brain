const OPENROUTER_MODELS_URL = "https://openrouter.ai/api/v1/models";

/**
 * Список моделей провайдера по возрастанию цены за промпт-токен —
 * для 👎-флоу слоя 9 (Promts/09_feedback_and_model_switch.md).
 */
export async function listModelsByPrice({ provider = "openrouter", limit = 15 } = {}) {
  if (provider !== "openrouter") {
    return {
      provider,
      note:
        "Прайс-каталог доступен только для provider=openrouter. Для остальных провайдеров " +
        "(например yandex) актуальные цены смотрите в консоли провайдера — публичного API цен нет.",
      models: [],
    };
  }

  const headers = { "Content-Type": "application/json" };
  if (process.env.OPENROUTER_API_KEY) {
    headers.Authorization = `Bearer ${process.env.OPENROUTER_API_KEY}`;
  }

  let response;
  try {
    response = await fetch(OPENROUTER_MODELS_URL, { headers });
  } catch (err) {
    return { provider, error: `Не удалось обратиться к OpenRouter: ${err.message}`, models: [] };
  }
  if (!response.ok) {
    return { provider, error: `OpenRouter вернул ${response.status}`, models: [] };
  }

  const json = await response.json();
  const models = (json.data || [])
    .map((m) => {
      const promptPrice = Number(m.pricing?.prompt);
      const completionPrice = Number(m.pricing?.completion);
      return {
        id: m.id,
        name: m.name || m.id,
        promptPricePerMTok: Number.isFinite(promptPrice) ? promptPrice * 1_000_000 : null,
        completionPricePerMTok: Number.isFinite(completionPrice) ? completionPrice * 1_000_000 : null,
      };
    })
    .filter((m) => m.promptPricePerMTok !== null)
    .sort((a, b) => a.promptPricePerMTok - b.promptPricePerMTok);

  return { provider, models: models.slice(0, limit), totalAvailable: models.length };
}
