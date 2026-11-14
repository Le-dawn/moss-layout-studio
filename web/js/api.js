const BASE = '';

export class ApiError extends Error {
  constructor(message, status = 0, data = {}) {
    super(message);
    this.name = 'ApiError';
    this.status = status;
    this.data = data;
  }
}

async function request(path, { method = 'GET', body } = {}) {
  let res;
  try {
    res = await fetch(BASE + path, {
      method,
      headers: body === undefined ? undefined : { 'Content-Type': 'application/json' },
      body: body === undefined ? undefined : JSON.stringify(body),
    });
  } catch (error) {
    throw new ApiError('连不上服务，确认 server.py 还在跑', 0);
  }
  const text = await res.text();
  let data = null;
  if (text) {
    try {
      data = JSON.parse(text);
    } catch (error) {
      throw new ApiError(`服务返回了非 JSON 内容（${res.status}）`, res.status);
    }
  }
  if (!res.ok) {
    throw new ApiError(data?.error || `请求失败（${res.status}）`, res.status, data || {});
  }
  return data;
}

export const api = {
  list: () => request('/api/layouts'),
  get: (id) => request(`/api/layouts/${id}`),
  create: (payload) => request('/api/layouts', { method: 'POST', body: payload }),
  update: (id, payload) => request(`/api/layouts/${id}`, { method: 'PUT', body: payload }),
  remove: (id) => request(`/api/layouts/${id}`, { method: 'DELETE' }),
  duplicate: (id) => request(`/api/layouts/${id}/duplicate`, { method: 'POST' }),
  importJson: (payload) => request('/api/import', { method: 'POST', body: payload }),
  compile: (payload) => request('/api/compile', { method: 'POST', body: payload }),
  example: () => request('/api/example'),
  health: () => request('/api/health'),
  uploadImage: (id, payload) => request(`/api/layouts/${id}/image`, { method: 'POST', body: payload }),
  removeImage: (id) => request(`/api/layouts/${id}/image`, { method: 'DELETE' }),
  imageUrl: (id) => `/api/layouts/${id}/image`,
};
