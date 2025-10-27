export const ERROR_CODES = [
  'rate_limited',
  'provider_unavailable',
  'timeout',
  'auth_failed',
  'sku_not_mapped',
  'tax_not_mapped',
  'status_not_mapped',
  'validation_rejected',
  'not_found',
  'unknown',
] as const;
export type ErrorCode = (typeof ERROR_CODES)[number];

/** Whether the engine retries this error on its own. */
export const RETRYABLE: Record<ErrorCode, boolean> = {
  rate_limited: true,
  provider_unavailable: true,
  timeout: true,
  auth_failed: false,
  sku_not_mapped: false,
  tax_not_mapped: false,
  status_not_mapped: false,
  validation_rejected: false,
  not_found: false,
  unknown: true,
};

export type Locale = 'en' | 'ru';

interface ErrorText {
  title: string;
  hint: string;
}

const en: Record<ErrorCode, ErrorText> = {
  rate_limited: {
    title: '{provider} asked us to slow down',
    hint: 'The job paused until the provider limit reset and then continued. Nothing to do here.',
  },
  provider_unavailable: {
    title: '{provider} is temporarily unavailable',
    hint: 'Retrying with growing pauses. If it keeps failing for more than an hour, check the provider status page.',
  },
  timeout: {
    title: '{provider} did not answer in time',
    hint: 'Retrying automatically. Large batches are split, so a repeat timeout usually means the provider is overloaded.',
  },
  auth_failed: {
    title: '{provider} rejected our access',
    hint: 'The key was revoked or the app was removed from the account. Reconnect it on the Connections page, then retry.',
  },
  sku_not_mapped: {
    title: 'SKU {sku} is not linked to a product in {provider}',
    hint: 'Pick the matching product on the Conflicts page. Orders waiting on this SKU will resume on their own.',
  },
  tax_not_mapped: {
    title: 'Tax rate {rate}% has no match in {provider}',
    hint: 'Map the rate on the Mapping page under Taxes. Waiting orders will resume after that.',
  },
  status_not_mapped: {
    title: 'Order status "{status}" has no match in {provider}',
    hint: 'Choose which status it should become on the Mapping page.',
  },
  validation_rejected: {
    title: '{provider} rejected the data',
    hint: 'Read the provider response below, fix the order or the mapping, then press Retry.',
  },
  not_found: {
    title: 'The record no longer exists in {provider}',
    hint: 'It was probably deleted after the event was sent. Nothing will be synced for it.',
  },
  unknown: {
    title: 'Unexpected error',
    hint: 'Retried automatically. If it ends up in failed jobs, the request and response below show what happened.',
  },
};

const ru: Record<ErrorCode, ErrorText> = {
  rate_limited: {
    title: '{provider} попросил снизить частоту запросов',
    hint: 'Задача подождала, пока у провайдера сбросится лимит, и продолжила работу. Делать ничего не нужно.',
  },
  provider_unavailable: {
    title: '{provider} временно недоступен',
    hint: 'Повторяем с растущими паузами. Если ошибка держится больше часа, проверьте страницу статуса провайдера.',
  },
  timeout: {
    title: '{provider} не ответил вовремя',
    hint: 'Повтор будет автоматически. Большие пакеты делятся на части, поэтому повторный таймаут обычно значит, что провайдер перегружен.',
  },
  auth_failed: {
    title: '{provider} отклонил доступ',
    hint: 'Ключ отозван или приложение удалили из аккаунта. Переподключите его на странице «Подключения» и нажмите «Повторить».',
  },
  sku_not_mapped: {
    title: 'Артикул {sku} не связан с товаром в {provider}',
    hint: 'Выберите нужный товар на экране «Конфликты». Заказы с этим артикулом продолжат синхронизацию сами.',
  },
  tax_not_mapped: {
    title: 'Ставке налога {rate}% нет пары в {provider}',
    hint: 'Сопоставьте ставку в разделе «Маппинг», вкладка «Налоги». Ожидающие заказы уйдут после этого.',
  },
  status_not_mapped: {
    title: 'Статусу заказа «{status}» нет пары в {provider}',
    hint: 'Выберите, в какой статус его переводить, в разделе «Маппинг».',
  },
  validation_rejected: {
    title: '{provider} не принял данные',
    hint: 'Посмотрите ответ провайдера ниже, поправьте заказ или маппинг и нажмите «Повторить».',
  },
  not_found: {
    title: 'Записи больше нет в {provider}',
    hint: 'Скорее всего, её удалили после отправки события. Синхронизировать нечего.',
  },
  unknown: {
    title: 'Непредвиденная ошибка',
    hint: 'Повтор будет автоматически. Если задача всё же упадёт, запрос и ответ ниже покажут, что произошло.',
  },
};

const TEXTS: Record<Locale, Record<ErrorCode, ErrorText>> = { en, ru };

export function describeError(
  code: ErrorCode,
  params: Record<string, string | number> = {},
  locale: Locale = 'en',
): ErrorText {
  const text = TEXTS[locale][code];
  const fill = (s: string) => s.replace(/\{(\w+)\}/g, (_, key: string) => String(params[key] ?? '…'));
  return { title: fill(text.title), hint: fill(text.hint) };
}
