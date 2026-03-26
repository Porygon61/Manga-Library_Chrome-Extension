import json
import os
import shutil
import tempfile
from selenium import webdriver
from selenium.webdriver.common.by import By
from selenium.webdriver.support.ui import WebDriverWait
from selenium.webdriver.support import expected_conditions as EC
import time

# --- CONFIGURATION ---
EXTENSION_PATH = r"C:\Users\filip\Desktop\Manga-Library_Chrome-Extension\frontend"
BUTTON_SELECTOR = "#manga-sync-fixed-btn"

# Using a fixed temp folder so settings (like Dev Mode) are saved
TEMP_PROFILE_DIR = os.path.join(tempfile.gettempdir(), "mangago_persistent_automation")


options = webdriver.ChromeOptions()
options.add_argument(f"--user-data-dir={TEMP_PROFILE_DIR}")
options.add_argument(f"--load-extension={EXTENSION_PATH}")
options.add_experimental_option("excludeSwitches", ["enable-logging"])


def massImport():
    if os.path.exists(TEMP_PROFILE_DIR):
        print(f"Cleaning up profile at {TEMP_PROFILE_DIR}...")
        try:
            # We use rmtree to delete the entire folder and its contents
            shutil.rmtree(TEMP_PROFILE_DIR)
            print("  [✓] Profile reset successful.")
        except Exception as e:
            print(f"  [!] Could not reset directory: {e}")
            print("  [!] Make sure all automated Chrome windows are closed!")
    try:
        print("Step 1: Launching Browser...")
        driver = webdriver.Chrome(options=options)
        # --- MANUAL INTERVENTION STEP ---
        print("\n--- ACTION REQUIRED ---")
        print("1. The browser is opening 'chrome://extensions/'")
        print("2. Toggle 'Developer mode' to ON (top right corner).")
        print("3. If your extension isn't there, click 'Load unpacked' and select:")
        print(f"   {EXTENSION_PATH}")
        print("4. IMPORTANT: Ensure the extension is 'Enabled'.")
        driver.get("chrome://extensions/")
        input(
            "\nOnce the extension is visible and enabled, press ENTER here to start..."
        )

        wait = WebDriverWait(driver, 20)
        collected_links = []

        for j in range(2):
            mangalist = j + 1
            # --- Phase 1: Scraping ---
            for i in range(20):
                target_page = f"https://www.mangago.me/home/people/3292403/manga/{mangalist}/?page={i+1}"
                print(f"\n--- Scraping Manga List {mangalist} ---")
                print(f"Scanning page {i+1}...")
                driver.get(target_page)

                try:
                    wait.until(EC.presence_of_element_located((By.TAG_NAME, "body")))
                    time.sleep(1)

                    elements = driver.find_elements(By.TAG_NAME, "a")
                    for e in elements:
                        href = e.get_attribute("href")
                        if href and "https://www.mangago.me/read-manga/" in href:
                            clean_href = href.split("#")[0].split("?")[0]
                            if clean_href not in collected_links:
                                collected_links.append(clean_href)
                except Exception as e:
                    print(f"Page {i+1} failed.")

        # --- Phase 2: Action ---
        print(f"\nCollected {len(collected_links)} links. Starting clicks...")
        for link in collected_links:
            driver.get(link)
            print(f"Target: {link}")

            try:
                # Wait for the extension to inject the button
                btn = wait.until(
                    EC.presence_of_element_located((By.CSS_SELECTOR, BUTTON_SELECTOR))
                )

                driver.execute_script("arguments[0].click();", btn)

                # Wait for the button to show success/fail state from the content script
                # This ensures the fetch() actually completed.
                wait.until(
                    lambda d: "Done"
                    in d.find_element(By.CSS_SELECTOR, BUTTON_SELECTOR).text
                    or "Failed" in d.find_element(By.CSS_SELECTOR, BUTTON_SELECTOR).text
                )

                print("  [✓] Sync Complete")
                time.sleep(1)  # Small buffer for the DB write to finish

            except Exception as e:
                print(f"  [X] Error occurred: {e}. Is the extension icon active?")

    finally:
        input("\nFinished. Press Enter to close...")
        driver.quit()


def massImport_withData():
    if os.path.exists(TEMP_PROFILE_DIR):
        print(f"Cleaning up profile at {TEMP_PROFILE_DIR}...")
        try:
            # We use rmtree to delete the entire folder and its contents
            shutil.rmtree(TEMP_PROFILE_DIR)
            print("  [✓] Profile reset successful.")
        except Exception as e:
            print(f"  [!] Could not reset directory: {e}")
            print("  [!] Make sure all automated Chrome windows are closed!")
    try:
        print("Step 1: Launching Browser...")
        driver = webdriver.Chrome(options=options)
        # --- MANUAL INTERVENTION STEP ---
        print("\n--- ACTION REQUIRED ---")
        print("1. The browser is opening 'chrome://extensions/'")
        print("2. Toggle 'Developer mode' to ON (top right corner).")
        print("3. If your extension isn't there, click 'Load unpacked' and select:")
        print(f"   {EXTENSION_PATH}")
        print("4. IMPORTANT: Ensure the extension is 'Enabled'.")
        driver.get("chrome://extensions/")
        input(
            "\nOnce the extension is visible and enabled, press ENTER here to start..."
        )

        wait = WebDriverWait(driver, 20)
        collected_links = []

        with open("backend/missing_mangago_links.json") as f:
            data = json.load(f)
            for obj in data:
                collected_links.append(obj["manga_link"])

        # --- Phase 2: Action ---
        print(f"\nCollected {len(collected_links)} links. Starting clicks...")
        for link in collected_links:
            try:
                driver.get(link)
                print(f"Target: {link}")

                btn = WebDriverWait(driver, 15).until(
                    EC.presence_of_element_located((By.CSS_SELECTOR, BUTTON_SELECTOR))
                )

                # Store the initial state (usually "+")
                initial_text = btn.text

                # 2. Click it
                driver.execute_script("arguments[0].click();", btn)
                print(f"Target: {link} - [Clicked]")

                # 3. Wait for the text to CHANGE to anything else
                # This prevents getting stuck if the emoji flashes and resets too fast
                WebDriverWait(driver, 15).until(
                    lambda d: d.find_element(By.CSS_SELECTOR, BUTTON_SELECTOR).text
                    != initial_text
                )

                # 4. Grab what the result was for your console logs
                result_text = driver.find_element(By.CSS_SELECTOR, BUTTON_SELECTOR).text
                print(f"  [✓] Result: {result_text}")

                # Short sleep so we don't spam the next page load before the current fetch finishes
                time.sleep(1)

                print("  [✓] Processed")
                time.sleep(0.5)  # Small buffer for the DB write to finish

            except Exception as e:
                print(
                    f"  [X] Skipped {link}: Button didn't appear or timed out. Error: {e}"
                )
                driver.refresh()

    finally:
        input("\nFinished. Press Enter to close...")
        driver.quit()


if __name__ == "__main__":
    # massImport()
    massImport_withData()
