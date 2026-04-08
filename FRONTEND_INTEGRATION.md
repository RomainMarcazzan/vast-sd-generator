# Frontend Integration Guide

Ce document explique comment intégrer le backend Hono/Prisma avec un frontend React + Vite en utilisant une approche type-safe avec OpenAPI.

## Overview

Au lieu de dupliquer les types entre backend et frontend, on génère automatiquement les types TypeScript depuis la spec OpenAPI du backend. Cela garantit que le frontend et le backend sont toujours synchronisés.

```
Backend (Hono + Zod)
    ↓
Spec OpenAPI à /api/doc
    ↓
openapi-typescript (CLI pour générer les types)
    ↓
src/types/api.ts (Types TypeScript automatiquement générés)
    ↓
openapi-fetch (Client HTTP type-safe)
    ↓
React Query (Gestion de l'état et du cache)
    ↓
Composants React (Typage complet end-to-end)
```

## Installation et Configuration

### 1. Créer le projet React + Vite

```bash
npm create vite@latest my-app -- --template react-ts
cd my-app
npm install
```

### 2. Installer les dépendances

```bash
# Génération des types depuis OpenAPI
npm install -D openapi-typescript

# Client HTTP type-safe
npm install openapi-fetch

# Gestion de l'état et du cache
npm install @tanstack/react-query

# Utilitaires
npm install axios  # Optionnel, si tu préfères axios à fetch
```

### 3. Créer un script npm pour générer les types

Dans `package.json`, ajoute :

```json
{
  "scripts": {
    "dev": "vite",
    "build": "tsc && vite build",
    "api:types": "openapi-typescript https://your-api.example.com/api/doc -o src/types/api.ts",
    "api:types:local": "openapi-typescript http://localhost:3000/api/doc -o src/types/api.ts"
  }
}
```

### 4. Générer les types pour la première fois

```bash
# Pour la production
npm run api:types

# Pour le développement local
npm run api:types:local
```

Cela crée automatiquement `src/types/api.ts` avec tous les types TypeScript de ton API.

## Structure du projet frontend

```
src/
├── types/
│   └── api.ts                 # Généré automatiquement
├── api/
│   └── client.ts              # Configuration du client API
├── hooks/
│   └── useUsers.ts            # React Query hooks personnalisés
├── components/
│   └── UsersList.tsx          # Composants React
├── lib/
│   └── queryClient.ts         # Configuration React Query
└── App.tsx
```

## Implémentation

### 1. Configuration du client API (`src/api/client.ts`)

```typescript
import createClient from 'openapi-fetch';
import type { paths } from '@/types/api';

// Client HTTP type-safe
export const apiClient = createClient<paths>({
  baseUrl: import.meta.env.VITE_API_URL || 'http://localhost:3000',
});

// Alternative avec openapi-fetch pour appels directs
// import { createClient } from 'openapi-fetch';
// const { GET, POST, PATCH, DELETE } = createClient<paths>({...});
```

### 2. Définition des query keys (`src/api/queries.ts`)

```typescript
import type { paths } from '@/types/api';

// Types extraits de la spec
type UserListParams = paths['/api/v1/users']['get']['parameters']['query'];

export const userQueries = {
  all: () => ['users'] as const,
  lists: () => [...userQueries.all(), 'list'] as const,
  list: (params?: UserListParams) => [...userQueries.lists(), params] as const,
  details: () => [...userQueries.all(), 'detail'] as const,
  detail: (id: string) => [...userQueries.details(), id] as const,
};
```

### 3. Hooks React Query (`src/hooks/useUsers.ts`)

```typescript
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import { apiClient } from '@/api/client';
import { userQueries } from '@/api/queries';
import type { paths } from '@/types/api';

type UserListParams = paths['/api/v1/users']['get']['parameters']['query'];
type CreateUserRequest = paths['/api/v1/users']['post']['requestBody']['content']['application/json'];

// Hook pour récupérer la liste des users
export const useListUsers = (params?: UserListParams) => {
  return useQuery({
    queryKey: userQueries.list(params),
    queryFn: async () => {
      const { data, error } = await apiClient.GET('/api/v1/users', {
        params: { query: params },
      });
      if (error) throw new Error('Failed to fetch users');
      return data;
    },
  });
};

// Hook pour créer un user
export const useCreateUser = () => {
  const queryClient = useQueryClient();

  return useMutation({
    mutationFn: async (data: CreateUserRequest) => {
      const { data: response, error } = await apiClient.POST('/api/v1/users', {
        body: data,
      });
      if (error) throw new Error('Failed to create user');
      return response;
    },
    onSuccess: () => {
      // Invalide la cache pour refetch les users
      queryClient.invalidateQueries({ queryKey: userQueries.lists() });
    },
  });
};
```

### 4. Configuration React Query (`src/lib/queryClient.ts`)

```typescript
import { QueryClient } from '@tanstack/react-query';

export const queryClient = new QueryClient({
  defaultOptions: {
    queries: {
      staleTime: 5 * 60 * 1000, // 5 minutes
      gcTime: 10 * 60 * 1000,   // 10 minutes (anciennement cacheTime)
    },
  },
});
```

### 5. Setup principal (`src/main.tsx`)

```typescript
import React from 'react';
import ReactDOM from 'react-dom/client';
import { QueryClientProvider } from '@tanstack/react-query';
import { queryClient } from '@/lib/queryClient';
import App from './App';
import './index.css';

ReactDOM.createRoot(document.getElementById('root')!).render(
  <React.StrictMode>
    <QueryClientProvider client={queryClient}>
      <App />
    </QueryClientProvider>
  </React.StrictMode>
);
```

### 6. Utilisation dans les composants (`src/components/UsersList.tsx`)

```typescript
import { useListUsers, useCreateUser } from '@/hooks/useUsers';

export function UsersList() {
  const { data, isLoading, error } = useListUsers({ page: 1, limit: 10 });
  const createUserMutation = useCreateUser();

  if (isLoading) return <div>Chargement...</div>;
  if (error) return <div>Erreur: {error.message}</div>;

  const handleCreate = async () => {
    // TypeScript vérifie les types automatiquement
    await createUserMutation.mutateAsync({
      email: 'test@example.com',
      name: 'John Doe',
      // Si tu oublies un champ requis ou ajoutes un champ invalide,
      // TypeScript génère une erreur !
    });
  };

  return (
    <div>
      <h1>Users</h1>
      {data?.data.map((user) => (
        <div key={user.id}>
          <p>{user.email}</p>
          <p>{user.name || 'N/A'}</p>
        </div>
      ))}
      <button onClick={handleCreate} disabled={createUserMutation.isPending}>
        {createUserMutation.isPending ? 'Création...' : 'Créer utilisateur'}
      </button>
    </div>
  );
}
```

## Configuration d'environnement (`.env`)

```bash
VITE_API_URL=https://api.voice-voyage.com
```

## Workflow de développement

### Quand tu modifies le backend

```bash
# 1. Change une route ou un schéma au backend
# Modifie src/routes/users/definitions.ts ou src/schemas/users.ts

# 2. Déploie ou relance le serveur local

# 3. Régénère les types du frontend
npm run api:types:local  # En développement
npm run api:types        # En production

# 4. TypeScript détecte automatiquement les changements
# Les composants React ont des erreurs si tu appelles l'API incorrectement
# L'IDE propose l'intellisense avec les nouveaux champs
```

### Intégration continue

Tu peux ajouter à ton CI/CD frontend :

```bash
npm run api:types  # Génère les types
npm run build      # Compile
```

## Avantages de cette approche

✅ **Typage complet end-to-end** : Erreurs détectées à la compilation, pas à runtime
✅ **Une source de vérité** : Les types viennent du backend (OpenAPI)
✅ **Pas de duplication** : Aucun copier-coller de types
✅ **Intellisense parfait** : Autocompletion dans VSCode
✅ **Refactoring sûr** : Renommer un champ = erreurs partout dans le frontend automatiquement
✅ **Cache management** : React Query gère le cache automatiquement
✅ **Synchronisation facile** : Un simple `npm run api:types` pour mettre à jour

## Dépannage

### Les types ne se mettent pas à jour
```bash
# Régénère les types
npm run api:types:local

# Redémarre le serveur Vite
npm run dev
```

### Erreur de CORS en développement
- Vérifie que le backend a `CORS_ORIGIN=*` en développement (voir CLAUDE.md)
- Ou configure le proxy Vite (`vite.config.ts`)

### Les endpoints ne sont pas typés
- Vérifie que le backend utilise correctement `@hono/zod-openapi`
- Vérifie que `app.doc('/api/doc', {...})` est configuré
- Accède à `http://localhost:3000/api/doc` pour voir la spec JSON brute

## Ressources

- [openapi-typescript](https://openapi-ts.dev/)
- [openapi-fetch](https://openapi-ts.dev/openapi-fetch)
- [TanStack React Query](https://tanstack.com/query/latest)
- [Hono OpenAPI](https://hono.dev/docs/guides/openapi)

## Prochaines étapes

1. Crée le projet React + Vite
2. Installe les dépendances
3. Configure le client API
4. Génère les types depuis ton backend
5. Crée les hooks React Query
6. Utilise les hooks dans tes composants
7. Profite du typage complet !
