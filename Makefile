ifeq ($(SIMULATOR),1)
	ARCHS = arm64 x86_64
	TARGET = simulator:clang:latest:14.0
else
	ifeq ($(THEOS_PACKAGE_SCHEME),rootless)
		TARGET = iphone:clang:16.5:15.0
		ARCHS = arm64 arm64e
	else
		TARGET = iphone:clang:14.5:8.0
		ARCHS = armv7 arm64 arm64e
		export PREFIX = $(THEOS)/toolchain/Xcode11.xctoolchain/usr/bin/
	endif
endif

INSTALL_TARGET_PROCESSES = MobileSafari SafariViewService com.apple.WebKit.WebContent

include $(THEOS)/makefiles/common.mk

TWEAK_NAME = Polyfills

$(TWEAK_NAME)_FILES = Tweak.x ModHeader.x PolyfillsBlacklistManager.m
$(TWEAK_NAME)_CFLAGS = -fobjc-arc
ifneq ($(THEOS_PACKAGE_SCHEME),rootless)
$(TWEAK_NAME)_CFLAGS += -Wno-unguarded-availability-new
endif

include $(THEOS_MAKE_PATH)/tweak.mk

BUNDLE_NAME = PolyfillsPreferences
PolyfillsPreferences_FILES = PolyfillsPreferences.m
PolyfillsPreferences_INSTALL_PATH = /Library/PreferenceBundles
PolyfillsPreferences_FRAMEWORKS = UIKit
PolyfillsPreferences_PRIVATE_FRAMEWORKS = Preferences
PolyfillsPreferences_CFLAGS = -fobjc-arc

include $(THEOS_MAKE_PATH)/bundle.mk

ifeq ($(SIMULATOR),1)
setup:: clean all
	@rm -f /opt/simject/$(TWEAK_NAME).dylib
	@cp -v $(THEOS_OBJ_DIR)/$(TWEAK_NAME).dylib /opt/simject/$(TWEAK_NAME).dylib
	@cp -v $(PWD)/$(TWEAK_NAME).plist /opt/simject/$(TWEAK_NAME).plist
endif
