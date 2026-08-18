import React, { Component, type ErrorInfo, type ReactNode } from 'react';
import { StyleSheet, Text, TouchableOpacity, View } from 'react-native';

import { reportarCaida } from './crash-reporter';

interface Props {
  children: ReactNode;
  fallback?: ReactNode;
  apiUrl?: string;
  onReset?: () => void;
}

interface State {
  hasError: boolean;
  error: Error | null;
}

export class ErrorBoundary extends Component<Props, State> {
  constructor(props: Props) {
    super(props);
    this.state = { hasError: false, error: null };
  }

  static getDerivedStateFromError(error: Error): State {
    return { hasError: true, error };
  }

  override componentDidCatch(error: Error, errorInfo: ErrorInfo): void {
    void reportarCaida(error, {
      fatal: false,
      stackManual: errorInfo.componentStack ?? undefined,
      apiUrl: this.props.apiUrl,
    });
  }

  handleReset = (): void => {
    this.setState({ hasError: false, error: null });
    this.props.onReset?.();
  };

  override render(): ReactNode {
    if (this.state.hasError) {
      if (this.props.fallback) {
        return this.props.fallback;
      }

      return (
        <View style={styles.contenedor} testID="error-boundary-fallback">
          <View style={styles.tarjeta}>
            <Text style={styles.icono}>⚠️</Text>
            <Text style={styles.titulo}>Ocurrió un problema</Text>
            <Text style={styles.descripcion}>
              La pantalla encontró un error inesperado. Tu progreso de ronda sigue seguro en el
              dispositivo.
            </Text>
            <TouchableOpacity
              style={styles.boton}
              onPress={this.handleReset}
              accessibilityRole="button"
              accessibilityLabel="Reintentar cargar la pantalla"
            >
              <Text style={styles.textoBoton}>Reintentar</Text>
            </TouchableOpacity>
          </View>
        </View>
      );
    }

    return this.props.children;
  }
}

const styles = StyleSheet.create({
  contenedor: {
    flex: 1,
    backgroundColor: '#0f172a',
    justifyContent: 'center',
    alignItems: 'center',
    padding: 24,
  },
  tarjeta: {
    backgroundColor: '#1e293b',
    borderRadius: 16,
    padding: 24,
    width: '100%',
    maxWidth: 400,
    alignItems: 'center',
    borderWidth: 1,
    borderColor: '#334155',
  },
  icono: {
    fontSize: 44,
    marginBottom: 16,
  },
  titulo: {
    fontSize: 20,
    fontWeight: '700',
    color: '#f8fafc',
    marginBottom: 12,
    textAlign: 'center',
  },
  descripcion: {
    fontSize: 14,
    lineHeight: 20,
    color: '#94a3b8',
    textAlign: 'center',
    marginBottom: 24,
  },
  boton: {
    backgroundColor: '#3b82f6',
    borderRadius: 10,
    paddingVertical: 14,
    paddingHorizontal: 28,
    width: '100%',
    alignItems: 'center',
  },
  textoBoton: {
    color: '#ffffff',
    fontSize: 16,
    fontWeight: '600',
  },
});
