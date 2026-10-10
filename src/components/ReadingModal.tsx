import React, { PropsWithChildren } from 'react';
import { Modal, Pressable, ScrollView, StyleSheet, Text, useWindowDimensions, View } from 'react-native';
import { SafeAreaProvider, SafeAreaView } from 'react-native-safe-area-context';
import { Ionicons } from '@expo/vector-icons';
import { LinePatternBackground } from './LinePatternBackground';
import { colors, styles } from './ui';

export function ReadingModal({ title, subtitle, backLabel, onClose, children }: PropsWithChildren<{
  title: string; subtitle?: string; backLabel: string; onClose: () => void;
}>) {
  const { width } = useWindowDimensions();
  const paddingHorizontal = width < 360 ? 16 : 20;
  return <Modal visible animationType="slide" presentationStyle="fullScreen" onRequestClose={onClose}>
    <SafeAreaProvider><SafeAreaView style={styles.safe} edges={['top', 'bottom', 'left', 'right']}>
      <LinePatternBackground />
      <View style={local.toolbar}><View style={[local.toolbarContent, { paddingHorizontal }]}>
        <Pressable accessibilityRole="button" accessibilityLabel={backLabel} onPress={onClose}
          style={({ pressed }) => [local.back, pressed && { opacity: 0.7 }]}>
          <Ionicons name="chevron-back" size={21} color={colors.darkGreen} /><Text style={local.backText}>{backLabel}</Text>
        </Pressable>
      </View></View>
      <ScrollView style={styles.scroll} keyboardShouldPersistTaps="handled" automaticallyAdjustKeyboardInsets
        contentContainerStyle={[styles.page, { paddingHorizontal }]}>
        <View><Text accessibilityRole="header" style={styles.title}>{title}</Text>{subtitle ? <Text style={styles.subtitle}>{subtitle}</Text> : null}</View>
        {children}
      </ScrollView>
    </SafeAreaView></SafeAreaProvider>
  </Modal>;
}

const local = StyleSheet.create({
  toolbar: { backgroundColor: colors.surface, borderBottomWidth: 1, borderBottomColor: colors.border },
  toolbarContent: { width: '100%', maxWidth: 960, alignSelf: 'center', paddingVertical: 6 },
  back: { minHeight: 48, flexDirection: 'row', alignItems: 'center', gap: 8, paddingHorizontal: 4 },
  backText: { color: colors.darkGreen, fontSize: 15, lineHeight: 22, fontWeight: '600', flexShrink: 1 },
});
