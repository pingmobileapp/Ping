import React, { useCallback, useEffect, useRef, useState } from 'react';
import {
  ActivityIndicator,
  Alert,
  FlatList,
  Image,
  Modal,
  Platform,
  Pressable,
  StyleSheet,
  Text,
  TextInput,
  View,
  useWindowDimensions,
} from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { supabase } from '../supabase';
import { useAuth } from '../lib/AuthContext';
import { colors, EVENT_IMAGE_ASPECT_RATIO } from '../lib/theme';

// Ping's Gallery: free public-domain photos other people's events already
// use (supabase/photo_library.sql), most-used first. Picking one costs no
// upload - the photo is already in Ping's storage, so the event just points
// at it.

type GalleryPhoto = { id: string; image_url: string; description: string };

type Props = {
  visible: boolean;
  onClose: () => void;
  onPick: (url: string) => void;
};

const PAGE = 60;

export default function PhotoGalleryModal({ visible, onClose, onPick }: Props) {
  const { session } = useAuth();
  const { width } = useWindowDimensions();
  const insets = useSafeAreaInsets();
  const [query, setQuery] = useState('');
  const [photos, setPhotos] = useState<GalleryPhoto[]>([]);
  const [loading, setLoading] = useState(false);
  const [isAdmin, setIsAdmin] = useState(false);
  const searchSeq = useRef(0);

  const load = useCallback(async (q: string) => {
    const seq = ++searchSeq.current;
    setLoading(true);
    let req = supabase.from('photo_library').select('id, image_url, description').order('use_count', { ascending: false }).limit(PAGE);
    // Every word has to match the description or the words it was found by.
    const words = q
      .toLowerCase()
      .replace(/[^a-z0-9\s]/g, ' ')
      .split(/\s+/)
      .filter((w) => w.length > 2)
      .slice(0, 5);
    for (const w of words) req = req.or(`search_terms.ilike.%${w}%,description.ilike.%${w}%`);
    const { data, error } = await req;
    if (seq !== searchSeq.current) return; // a newer search already started
    if (error) console.error('Error loading gallery:', error);
    setPhotos((data as GalleryPhoto[]) || []);
    setLoading(false);
  }, []);

  useEffect(() => {
    if (!visible) return;
    setQuery('');
    load('');
    if (session?.user?.id) {
      supabase
        .from('profiles')
        .select('is_admin')
        .eq('id', session.user.id)
        .maybeSingle()
        .then(({ data }) => setIsAdmin(!!data?.is_admin));
    }
  }, [visible, load, session?.user?.id]);

  // Waits for a pause in typing before searching.
  useEffect(() => {
    if (!visible) return;
    const t = setTimeout(() => load(query), 300);
    return () => clearTimeout(t);
  }, [query, visible, load]);

  const pick = (p: GalleryPhoto) => {
    supabase.rpc('use_gallery_photo', { p_id: p.id }).then(({ error }) => {
      if (error) console.error('Error counting gallery use:', error);
    });
    onPick(p.image_url);
  };

  // Admin only: pull an unsuitable photo out of the Gallery.
  const hide = (p: GalleryPhoto) => {
    if (!isAdmin) return;
    Alert.alert('Remove from Gallery?', 'Events already using it keep it.', [
      { text: 'Cancel', style: 'cancel' },
      {
        text: 'Remove',
        style: 'destructive',
        onPress: async () => {
          const { data, error } = await supabase.rpc('hide_gallery_photo', { p_id: p.id });
          if (error || !data) {
            Alert.alert("Couldn't remove it", 'Try again in a moment.');
            return;
          }
          setPhotos((prev) => prev.filter((x) => x.id !== p.id));
        },
      },
    ]);
  };

  const columns = width >= 700 ? 3 : 2;
  const gap = 8;
  const tileWidth = (Math.min(width, 900) - 32 - gap * (columns - 1)) / columns;

  return (
    <Modal visible={visible} animationType="slide" presentationStyle="pageSheet" onRequestClose={onClose}>
      {/* iOS shows this as a page sheet below the status bar; Android's
          full-screen modal needs the status bar inset itself. */}
      <View style={[styles.container, { paddingTop: Platform.OS === 'android' ? insets.top : 0, paddingBottom: insets.bottom }]}>
        <View style={styles.header}>
          <Text style={styles.title}>Gallery</Text>
          <Pressable onPress={onClose} hitSlop={12} accessibilityRole="button">
            <Text style={styles.cancel}>Cancel</Text>
          </Pressable>
        </View>
        <TextInput
          style={styles.search}
          placeholder="Search, like barbecue or camping"
          placeholderTextColor={colors.textMuted}
          value={query}
          onChangeText={setQuery}
          autoCorrect={false}
          returnKeyType="search"
          clearButtonMode="while-editing"
        />
        {loading && photos.length === 0 ? (
          <ActivityIndicator style={{ marginTop: 40 }} color={colors.primary} />
        ) : photos.length === 0 ? (
          <Text style={styles.empty}>
            {query.trim() ? `No photos for "${query.trim()}" yet.` : 'No photos in the Gallery yet.'}
          </Text>
        ) : (
          <FlatList
            key={columns}
            data={photos}
            keyExtractor={(p) => p.id}
            numColumns={columns}
            columnWrapperStyle={{ gap }}
            contentContainerStyle={{ paddingHorizontal: 16, paddingBottom: 32, gap }}
            keyboardShouldPersistTaps="handled"
            keyboardDismissMode="on-drag"
            renderItem={({ item }) => (
              <Pressable
                onPress={() => pick(item)}
                onLongPress={isAdmin ? () => hide(item) : undefined}
                accessibilityRole="imagebutton"
                accessibilityLabel={item.description || 'Gallery photo'}
                style={({ pressed }) => [{ width: tileWidth, opacity: pressed ? 0.7 : 1 }]}
              >
                <Image source={{ uri: item.image_url }} style={[styles.tile, { width: tileWidth }]} resizeMode="cover" />
              </Pressable>
            )}
          />
        )}
        <Text style={styles.footnote}>Free public-domain photos. The Gallery grows as people add photos to events.</Text>
      </View>
    </Modal>
  );
}

const styles = StyleSheet.create({
  container: { flex: 1, backgroundColor: colors.background },
  header: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    paddingHorizontal: 16,
    paddingTop: 16,
    paddingBottom: 8,
  },
  title: { fontSize: 20, fontWeight: '700', color: colors.textPrimary },
  cancel: { fontSize: 16, color: colors.primaryDark },
  search: {
    marginHorizontal: 16,
    marginBottom: 12,
    paddingHorizontal: 12,
    paddingVertical: 10,
    borderRadius: 10,
    borderWidth: 1,
    borderColor: colors.border,
    backgroundColor: colors.surfaceLight,
    color: colors.textPrimary,
    fontSize: 16,
  },
  tile: { aspectRatio: EVENT_IMAGE_ASPECT_RATIO, borderRadius: 10, backgroundColor: colors.surfaceAlt },
  empty: { textAlign: 'center', color: colors.textSecondary, marginTop: 40, paddingHorizontal: 32 },
  footnote: { textAlign: 'center', color: colors.textMuted, fontSize: 12, paddingHorizontal: 24, paddingVertical: 8 },
});
