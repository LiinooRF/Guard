/**
 * @voxia/shared — contrato comun entre api, web y movil.
 *
 * Todo lo que tenga que estar de acuerdo entre el backend y sus clientes vive
 * aca: roles, entidades del dominio y las reglas configurables. Es la razon
 * principal de que esto sea un monorepo — asi el contrato no se desincroniza.
 */
export * from './roles';
export * from './permissions';
export * from './rules';
export * from './domain';
