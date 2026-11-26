-- Nombres visibles en español para los presets existentes.
UPDATE "KitchenPosition" SET name = 'Jefe de cocina' WHERE "isSystemPreset" = true AND code = 'CHEF_DE_CUISINE' AND name = 'Chef de cuisine';
UPDATE "KitchenPosition" SET name = 'Subjefe de cocina' WHERE "isSystemPreset" = true AND code = 'SOUS_CHEF' AND name = 'Sous-chef';
UPDATE "KitchenPosition" SET name = 'Jefe de partida' WHERE "isSystemPreset" = true AND code = 'CHEF_DE_PARTIE' AND name = 'Chef de partie';
UPDATE "KitchenPosition" SET name = 'Cocinero' WHERE "isSystemPreset" = true AND code = 'CUISINIER' AND name = 'Cuisinier';
UPDATE "KitchenPosition" SET name = 'Asistente de cocina' WHERE "isSystemPreset" = true AND code = 'COMMIS' AND name = 'Commis';
UPDATE "KitchenPosition" SET name = 'Rondador' WHERE "isSystemPreset" = true AND code = 'TOURNANT' AND name = 'Tournant';
UPDATE "KitchenPosition" SET name = 'Camarero de pase' WHERE "isSystemPreset" = true AND code = 'ABOYEUR' AND name = 'Aboyeur / Expo';